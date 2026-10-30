"""Keryx — Hermes activity graph, FastAPI backend.

Reads Hermes state (sqlite WAL) through snapshot copies keyed on file mtime, plus the
cron store and gateway logs, and exposes:
  GET /api/graph?hours=24[&at=<epoch>]   nodes/links (at = replay the graph as of that moment)
  GET /api/now                            running sessions with request + latest step
  GET /api/status                         health header (gateway, telegram, cron, errors, orphans)
  GET /api/cost?hours=24                  token/cost totals per model for the window
  GET /api/stream?hours=24                SSE: pushes {graph, now, status, cost, tasks} when data changes
  GET /api/tasks                          delegations board + scheduled jobs with run history
  GET /api/diagnostics                    redacted snapshot for bug reports (no prompts, no keys)
  GET /api/qr?text=                       QR code (SVG) for opening Keryx on a phone
  GET /api/health                         liveness
  /                                       the React app (static/)
"""
from __future__ import annotations

import asyncio
import hmac
import json
import math
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

DATA = Path(os.environ.get("HERMES_DATA", "/opt/data"))
STATIC = Path(__file__).parent / "static"
ACTIVE_WINDOW = int(os.environ.get("ACTIVE_WINDOW", "300"))      # s: "touched recently"
STALE_AFTER = int(os.environ.get("STALE_AFTER", "1800"))         # s: running-but-idle → stale
MAX_SESSIONS = 600
# Context window assumed when Hermes does not say; used for the per-session context gauge.
CONTEXT_LENGTH = int(os.environ.get("CONTEXT_LENGTH", "400000"))
CONTEXT_LIMITS = {"gpt-5.4-mini": 400000, "gpt-5": 400000, "claude": 200000, "gemini": 1000000}
FILE_TOOLS = {"write_file": "write", "patch": "patch", "read_file": "read", "search_files": "search"}
# Where the Hermes dashboard (hermes dashboard, port 9119) is reachable from the browser, e.g.
# http://192.168.1.100:9119. Empty = no deep links. Keryx never calls it; the links are for the user.
DASHBOARD_URL = os.environ.get("HERMES_DASHBOARD_URL", "").strip().rstrip("/")
TODO_TOOLS = ("todo_list", "todo")       # Hermes' task-list tool; its result is the agent's current plan
# Optional shared secret. When set, every /api/* route except /api/health needs it as a bearer
# header, a `keryx_token` cookie, or `?token=` (the page sets the cookie from the first).
TOKEN = os.environ.get("KERYX_TOKEN", "").strip()

# Hermes `sessions.end_reason` values, grouped by what they mean for the picture.
# Orphans: the gateway (or a websocket backend) came back and reaped a session it no longer owned.
ORPHAN_REASONS = {"startup_orphan_reap", "ws_orphan_reap"}
# Closed by the human rather than by the agent finishing: CLI/TUI exit, explicit reset, websocket gone.
USER_CLOSE_REASONS = {"cli_close", "tui_shutdown", "tui_close", "user_exit", "session_reset", "ws_disconnect"}
# The session was compacted: Hermes ends it and continues the same conversation in a child session.
COMPRESSION_REASON = "compression"

app = FastAPI(title="Keryx", version="2.3")


def authorised(request: Request) -> bool:
    if not TOKEN:
        return True
    auth = request.headers.get("authorization", "")
    presented = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    presented = presented or request.cookies.get("keryx_token", "") or request.query_params.get("token", "")
    return bool(presented) and hmac.compare_digest(presented, TOKEN)


@app.middleware("http")
async def require_token(request: Request, call_next):
    """Keryx shows prompts and tool output; with KERYX_TOKEN set nothing under /api is served
    without it. The static app stays open (it is only the viewer), /api/health stays open for
    liveness probes but then omits the data path."""
    path = request.url.path
    if TOKEN and path.startswith("/api/") and path != "/api/health" and not authorised(request):
        return JSONResponse({"error": "unauthorised", "hint": "send Authorization: Bearer <KERYX_TOKEN>"}, status_code=401,
                            headers={"WWW-Authenticate": "Bearer"})
    response = await call_next(request)
    if TOKEN and request.query_params.get("token") and authorised(request) and "keryx_token" not in request.cookies:
        response.set_cookie("keryx_token", TOKEN, httponly=True, samesite="strict", max_age=30 * 86400)
    return response


# ----------------------------------------------------------------- helpers
def ts(v: Any) -> Optional[float]:
    """Epoch float from epoch/numeric-string/ISO-8601; None if unknown."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        pass
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d.timestamp()
    except ValueError:
        return None


def short(text: Any, n: int = 90) -> str:
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    return t if len(t) <= n else t[: n - 1] + "…"


def file_sig(*paths: Path) -> tuple:
    sig = []
    for p in paths:
        try:
            st = p.stat()
            sig.append((str(p), st.st_mtime_ns, st.st_size))
        except FileNotFoundError:
            sig.append((str(p), 0, 0))
    return tuple(sig)


# ----------------------------------------------------------------- snapshots
class Snapshot:
    """In-memory copy of a sqlite file, refreshed only when the file (or its WAL) changes."""

    def __init__(self, path: Path):
        self.path = path
        self.sig = None
        self.db: Optional[sqlite3.Connection] = None
        self.lock = threading.Lock()

    def get(self) -> Optional[sqlite3.Connection]:
        sig = file_sig(self.path, Path(str(self.path) + "-wal"))
        with self.lock:
            if self.db is not None and sig == self.sig:
                return self.db
            if not self.path.exists():
                return None
            src = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, timeout=5)
            mem = sqlite3.connect(":memory:", check_same_thread=False)
            src.backup(mem)
            src.close()
            mem.row_factory = sqlite3.Row
            if self.db is not None:
                self.db.close()
            self.db, self.sig = mem, sig
            return mem


STATE = Snapshot(DATA / "state.db")
CRON_EXEC = Snapshot(DATA / "cron" / "executions.db")
CRON_INCIDENTS = Snapshot(DATA / "cron" / "incidents.db")      # Hermes' failure-signature ledger
CRON_DELIVERIES = Snapshot(DATA / "cron" / "deliveries.db")    # Hermes' delivery queue


def configure(data_dir: Path) -> None:
    """Point Keryx at another Hermes data directory (tests; a future reload endpoint).
    Rebuilds the snapshots and drops the response cache so nothing from the old directory leaks."""
    global DATA, STATE, CRON_EXEC, CRON_INCIDENTS, CRON_DELIVERIES
    DATA = Path(data_dir)
    STATE = Snapshot(DATA / "state.db")
    CRON_EXEC = Snapshot(DATA / "cron" / "executions.db")
    CRON_INCIDENTS = Snapshot(DATA / "cron" / "incidents.db")
    CRON_DELIVERIES = Snapshot(DATA / "cron" / "deliveries.db")
    with _cache_lock:
        _cache.clear()


def data_signature() -> tuple:
    return file_sig(DATA / "state.db", DATA / "state.db-wal", DATA / "cron" / "jobs.json",
                    DATA / "cron" / "executions.db", DATA / "cron" / "incidents.db", DATA / "cron" / "deliveries.db",
                    DATA / "logs" / "errors.log")


# ----------------------------------------------------------------- loaders
def table_columns(db, table: str) -> set[str]:
    return {r[1] for r in db.execute(f"pragma table_info({table})")}


def live_rows_sql(db, alias: str = "") -> str:
    """SQL fragment keeping only the rows Hermes itself still shows.

    Since compaction landed, `messages` carries `active` (1 = part of the live transcript) and
    `compacted` (1 = archived original kept for search). Compaction writes a stub and archives the
    original, so counting every row double counts tool calls and the trace shows both copies.
    Older databases lack the column: then every row is live and the fragment is empty."""
    if "active" not in table_columns(db, "messages"):
        return ""
    return f" and {alias + '.' if alias else ''}active = 1"


def load_sessions(db) -> list[dict]:
    cols = table_columns(db, "sessions")
    rows = db.execute(
        "select * from sessions order by coalesce(last_activity_at, started_at) desc limit ?", (MAX_SESSIONS,)
    ).fetchall()
    out = []
    for r in rows:
        s = dict(r)
        for k in ("started_at", "ended_at", "last_activity_at"):
            s[k] = ts(s.get(k))
        s.setdefault("parent_session_id", None)
        s["title"] = s.get("title") or s.get("display_name") or s["id"]
        s["prompt_tokens"] = None
        s["fork"] = None                        # 'delegate' | 'branch' when model_config says the child was forked
        try:
            cfg = json.loads(s.get("model_config") or "{}") or {}
            s["prompt_tokens"] = (cfg.get("_usage_anchor") or {}).get("prompt_tokens")
            # Hermes copies model_config onto a compression continuation, so a marker only counts
            # when it points at this row's own parent (same rule as hermes_state_messages).
            parent = s.get("parent_session_id")
            if parent and cfg.get("_delegate_from") == parent:
                s["fork"] = "delegate"
            elif parent and cfg.get("_branched_from") == parent:
                s["fork"] = "branch"
        except Exception:
            pass
        if s.get("source") == "tool":
            s["fork"] = "delegate"
        s["context_limit"] = context_limit(s.get("model"))
        out.append(s)
    return out


# ----------------------------------------------------------------- compression lineages
def is_continuation(child: dict, parent: Optional[dict]) -> bool:
    """A child continues its parent's conversation after compaction: the parent ended with
    `compression` and the child is not an explicit branch, delegate or tool fork."""
    return bool(parent) and parent.get("end_reason") == COMPRESSION_REASON and not child.get("fork")


def logical_sessions(sessions: list[dict]) -> tuple[list[dict], dict[str, str]]:
    """Fold compression lineages into one logical session each.

    Hermes compacts a long conversation by ending the session (end_reason `compression`) and
    continuing in a child row with the same source and title. Drawing every segment makes one
    chat look like a chain of subagents. Here each lineage becomes a single dict: the tip's row
    (status, model, last activity, context) with the root's identity and start time, the
    segment ids in order, summed counts and `compactions` = number of folds.

    Returns (logical sessions, alias) where alias maps every segment id to its logical id (the
    root's id, which never changes, so node ids, toasts and deep links survive a compaction)."""
    by_id = {s["id"]: s for s in sessions}
    root_of: dict[str, str] = {}

    def root(sid: str) -> str:
        if sid in root_of:
            return root_of[sid]
        s = by_id[sid]
        chain = []
        while True:
            chain.append(s["id"])
            parent = by_id.get(s.get("parent_session_id") or "")
            if parent is None or not is_continuation(s, parent) or parent["id"] in chain or len(chain) > 100:
                break
            if parent["id"] in root_of:
                s = by_id[root_of[parent["id"]]]
                chain.append(s["id"])
                break
            s = parent
        r = chain[-1]
        for c in chain:
            root_of[c] = r
        return r

    groups: dict[str, list[dict]] = {}
    for s in sessions:
        groups.setdefault(root(s["id"]), []).append(s)
    out = []
    for rid, segs in groups.items():
        segs.sort(key=lambda s: (s["started_at"] or 0, s["id"]))
        head, tip = segs[0], segs[-1]
        ls = dict(tip)
        ls.update(
            id=rid, started_at=head["started_at"], title=tip.get("title") or head.get("title"),
            parent_session_id=head.get("parent_session_id"), fork=head.get("fork"),
            last_activity_at=max((s["last_activity_at"] or s["started_at"] or 0) for s in segs),
            message_count=sum(s.get("message_count") or 0 for s in segs),
            tool_call_count=sum(s.get("tool_call_count") or 0 for s in segs),
            segments=[s["id"] for s in segs], compactions=len(segs) - 1, tip_id=tip["id"],
            compacted_at=[s["ended_at"] for s in segs[:-1]],
        )
        out.append(ls)
    return out, root_of


def is_subagent(ls: dict, known: set[str]) -> bool:
    """A logical session is a subagent when it was delegated (marker or tool source), when its
    title says so, or when it has an unmarked parent we know about (older Hermes wrote no markers).
    A `branch` is a conversation fork the human made, not a subagent."""
    if ls.get("fork") == "delegate":
        return True
    if ls.get("fork") == "branch":
        return False
    if str(ls.get("title") or "").lower().startswith("subagent"):
        return True
    return bool(ls.get("parent_session_id")) and ls["parent_session_id"] in known


def context_limit(model: Optional[str]) -> int:
    m = (model or "").lower()
    for key, lim in CONTEXT_LIMITS.items():
        if key in m:
            return lim
    return CONTEXT_LENGTH


def tool_call_files(tool_calls_json: Any) -> list[dict]:
    """Files named in assistant tool calls (write_file / patch / read_file / search_files)."""
    try:
        calls = json.loads(tool_calls_json) if isinstance(tool_calls_json, str) else (tool_calls_json or [])
    except Exception:
        return []
    out = []
    for c in calls:
        fn = c.get("function", {}) if isinstance(c, dict) else {}
        name = fn.get("name") or c.get("name")
        op = FILE_TOOLS.get(name)
        if not op:
            continue
        args = fn.get("arguments") or c.get("arguments") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {}
        path = args.get("path") or args.get("file_path") or args.get("filename") or args.get("directory")
        if path:
            out.append({"path": str(path), "op": op})
    return out


def tool_call_names(tool_calls_json: Any) -> list[str]:
    try:
        calls = json.loads(tool_calls_json) if isinstance(tool_calls_json, str) else (tool_calls_json or [])
        return [c.get("function", {}).get("name") or c.get("name") or "?" for c in calls]
    except Exception:
        return []


def tool_result_failed(content: Any) -> bool:
    """Hermes tool results are JSON like {"output":..., "exit_code":0, "error":null}."""
    if not content:
        return False
    text = str(content)
    try:
        d = json.loads(text)
    except Exception:
        return text.lstrip().startswith(("Error", "Traceback"))
    if not isinstance(d, dict):
        return False
    if d.get("error"):
        return True
    ec = d.get("exit_code")
    if isinstance(ec, int) and ec != 0:
        return True
    out = str(d.get("output") or "")
    return out.lstrip().startswith("Traceback")


def hidden_rows_sql(db) -> str:
    """Skip display_kind='hidden' rows: model-facing scaffolding Hermes itself never paints."""
    if "display_kind" not in table_columns(db, "messages"):
        return ""
    return " and coalesce(display_kind, '') <> 'hidden'"


# The digest only needs the first 400 characters of a chat turn, and of a tool result only the
# fields tool_result_failed() looks at. Trimming in SQL keeps megabytes of tool output out of the
# process: a window of 600 sessions easily carries tens of MB of content.
DIGEST_CONTENT_SQL = (
    "case when role = 'tool' and json_valid(content) then json_object("
    "'error', json_extract(content, '$.error'), 'exit_code', json_extract(content, '$.exit_code'), "
    "'output', substr(coalesce(json_extract(content, '$.output'), ''), 1, 40)) "
    "else substr(content, 1, 400) end"
)


def load_messages(db, session_ids: list[str], upto: Optional[float],
                  group: Optional[dict[str, str]] = None) -> dict[str, dict]:
    """Per-session digest: first user message, last assistant step, tool stats (+errors), timestamps.
    With `group` (segment id → logical id) the rows of a compression lineage flow, in time order,
    into one digest, so "request" is the root's first message and "last step" the tip's."""
    if not session_ids:
        return {}
    group = group or {}
    q = ",".join("?" * len(session_ids))
    params: list[Any] = list(session_ids)
    where_t = ""
    if upto is not None:
        where_t = " and timestamp <= ?"
        params.append(upto)
    kind_col = ", display_kind" if "display_kind" in table_columns(db, "messages") else ", null as display_kind"
    sql = (f"select session_id, role, {DIGEST_CONTENT_SQL} as content, tool_name, tool_calls, timestamp, finish_reason{kind_col} "
           f"from messages where session_id in ({q}){where_t}{live_rows_sql(db)}{hidden_rows_sql(db)} order by timestamp asc, id asc")
    try:
        rows = db.execute(sql, params).fetchall()
    except sqlite3.OperationalError:                       # SQLite without the JSON functions: full content
        rows = db.execute(sql.replace(DIGEST_CONTENT_SQL, "content"), params).fetchall()
    out: dict[str, dict] = {}
    for r in rows:
        sid = group.get(r["session_id"], r["session_id"])
        d = out.setdefault(sid, {"request": None, "last_step": None, "last_ts": None, "last_assistant_ts": None,
                                 "tools": {}, "user_messages": 0, "tool_calls": 0, "tool_errors": 0,
                                 "recent_calls": [], "finish": None,
                                 "last_role": None, "final_reply": False, "files": []})
        t = ts(r["timestamp"]) or 0
        d["last_ts"] = max(d["last_ts"] or 0, t)
        role = r["role"]
        d["last_role"] = role
        if role == "user":
            d["final_reply"] = False
            # Hermes' injected event rows (model switch, auto-continue, delegation results…) wake the
            # agent but are not the human speaking; a `steer` is the human, mid-turn.
            if r["display_kind"] in EVENT_KINDS and r["display_kind"] != "steer":
                continue
            d["user_messages"] += 1
            if d["request"] is None and r["content"]:
                d["request"] = short(r["content"], 160)
        elif role == "assistant":
            names = tool_call_names(r["tool_calls"])
            d["finish"] = r["finish_reason"]
            d["last_assistant_ts"] = t
            d["final_reply"] = not names            # a reply with no tool calls ends the turn
            for f in tool_call_files(r["tool_calls"]):
                f["ts"] = t
                d["files"].append(f)
            if names:
                d["last_step"] = "calling " + ", ".join(names[:3])
            elif r["content"]:
                d["last_step"] = short(r["content"], 140)
        elif role == "tool":
            d["final_reply"] = False
            name = r["tool_name"] or "tool"
            tool = d["tools"].setdefault(name, {"calls": 0, "errors": 0, "last": 0})
            tool["calls"] += 1
            tool["last"] = max(tool["last"], t)
            d["tool_calls"] += 1
            d["recent_calls"].append(t)
            if tool_result_failed(r["content"]):
                tool["errors"] += 1
                d["tool_errors"] += 1
    return out


def load_usage(db, session_ids: list[str]) -> dict[str, dict]:
    if not session_ids:
        return {}
    q = ",".join("?" * len(session_ids))
    cols = table_columns(db, "session_model_usage")
    opt = lambda c: f"sum(coalesce({c},0))" if c in cols else "0"      # columns newer Hermes added
    try:
        rows = db.execute(
            f"select model, coalesce(billing_provider,'') as provider, sum(input_tokens) i, sum(output_tokens) o, "
            f"sum(cache_read_tokens) c, {opt('cache_write_tokens')} cw, {opt('reasoning_tokens')} rt, sum(api_call_count) n, "
            f"sum(coalesce(estimated_cost_usd,0)) est, {opt('actual_cost_usd')} act, "
            f"{'cost_status' if 'cost_status' in cols else 'null'} as cost_status, "
            f"count(distinct session_id) sessions from session_model_usage where session_id in ({q}) group by 1,2",
            session_ids,
        ).fetchall()
    except sqlite3.OperationalError:
        return {}
    out = {}
    for r in rows:
        key = r["model"] or "unknown-model"
        cur = out.setdefault(key, {"model": key, "providers": set(), "input": 0, "output": 0, "cache_read": 0,
                                   "cache_write": 0, "reasoning": 0, "calls": 0, "cost_usd": 0.0, "estimated_usd": 0.0,
                                   "actual_usd": 0.0, "cost_status": set(), "sessions": 0})
        if r["provider"]:
            cur["providers"].add(r["provider"])
        cur["input"] += r["i"] or 0
        cur["output"] += r["o"] or 0
        cur["cache_read"] += r["c"] or 0
        cur["cache_write"] += r["cw"] or 0
        cur["reasoning"] += r["rt"] or 0
        cur["calls"] += r["n"] or 0
        cur["estimated_usd"] += r["est"] or 0
        cur["actual_usd"] += r["act"] or 0
        if r["cost_status"]:
            cur["cost_status"].add(r["cost_status"])
        cur["sessions"] += r["sessions"] or 0
    for v in out.values():
        v["providers"] = sorted(v["providers"])
        denom = v["input"] + v["cache_read"]
        v["cache_hit"] = round(v["cache_read"] / denom, 3) if denom else 0.0
        v["cost_usd"], v["cost_basis"] = cost_of(v["estimated_usd"], v["actual_usd"], v["cost_status"])
        v["cost_status"] = sorted(v["cost_status"])
        v["estimated_usd"], v["actual_usd"] = round(v["estimated_usd"], 4), round(v["actual_usd"], 4)
    return out


def session_usage(db, session_ids: list[str], alias: Optional[dict[str, str]] = None) -> dict[str, dict]:
    """Per-session totals (summed over a lineage's segments when `alias` maps them to one id)."""
    out: dict[str, dict] = {}
    if not session_ids:
        return out
    alias = alias or {}
    cols = table_columns(db, "session_model_usage")
    opt = lambda c: f"sum(coalesce({c},0))" if c in cols else "0"
    try:
        q = ",".join("?" * len(session_ids))
        for r in db.execute(f"select session_id, sum(input_tokens) i, sum(output_tokens) o, sum(cache_read_tokens) c, "
                            f"{opt('cache_write_tokens')} cw, {opt('reasoning_tokens')} rt, sum(api_call_count) n, "
                            f"sum(coalesce(estimated_cost_usd,0)) est, {opt('actual_cost_usd')} act, "
                            f"{'group_concat(distinct cost_status)' if 'cost_status' in cols else 'null'} st "
                            f"from session_model_usage where session_id in ({q}) group by 1", session_ids):
            u = out.setdefault(alias.get(r["session_id"], r["session_id"]),
                               {"tokens_in": 0, "tokens_out": 0, "cache_read": 0, "cache_write": 0, "reasoning": 0,
                                "api_calls": 0, "estimated_usd": 0.0, "actual_usd": 0.0, "statuses": set()})
            u["tokens_in"] += r["i"] or 0; u["tokens_out"] += r["o"] or 0; u["cache_read"] += r["c"] or 0
            u["cache_write"] += r["cw"] or 0; u["reasoning"] += r["rt"] or 0; u["api_calls"] += r["n"] or 0
            u["estimated_usd"] += r["est"] or 0; u["actual_usd"] += r["act"] or 0
            u["statuses"].update((r["st"] or "").split(","))
    except sqlite3.OperationalError:
        return {}
    for u in out.values():
        u["cost_usd"], u["cost_basis"] = cost_of(u["estimated_usd"], u["actual_usd"], u.pop("statuses"))
        u["estimated_usd"], u["actual_usd"] = round(u["estimated_usd"], 4), round(u["actual_usd"], 4)
    return out


def cost_of(estimated: float, actual: float, statuses) -> tuple[float, str]:
    """What to call the money: Hermes stamps `cost_status` per usage row ("ok" = the provider
    reported the real cost, "estimated" = priced from a table, "included" = subscription,
    "unknown"). Prefer the provider's figure; fall back to the estimate; say which one it is."""
    statuses = set(statuses or ())
    if actual > 0:
        return round(actual, 4), "actual"
    if estimated > 0:
        return round(estimated, 4), "estimated"
    if "included" in statuses:
        return 0.0, "included"
    return 0.0, "unknown"


def load_delegations(db) -> list[dict]:
    try:
        rows = db.execute(
            "select delegation_id, origin_session, parent_session_id, state, delivery_state, dispatched_at, "
            "completed_at, task_json from async_delegations order by dispatched_at desc limit 300"
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    out = []
    for r in rows:
        d = dict(r)
        d["dispatched_at"], d["completed_at"] = ts(d.get("dispatched_at")), ts(d.get("completed_at"))
        try:
            d["goal"] = short(json.loads(d.pop("task_json") or "{}").get("goal"), 140)
        except Exception:
            d["goal"] = None
        out.append(d)
    return out


def load_cron() -> tuple[list[dict], list[dict]]:
    try:
        jobs = json.loads((DATA / "cron" / "jobs.json").read_text()).get("jobs", [])
    except Exception:
        jobs = []
    execs: list[dict] = []
    db = CRON_EXEC.get()
    if db is not None:
        try:
            cols = table_columns(db, "executions")
            for r in db.execute("select * from executions order by coalesce(claimed_at, started_at) desc, rowid desc limit 500"):
                e = {k: r[k] for k in ("job_id", "status", "started_at", "finished_at", "error")}
                for k in ("scheduled_instant", "progress_at", "delivery_outcome", "claimed_at", "source"):
                    e[k] = r[k] if k in cols else None
                for k in ("started_at", "finished_at", "scheduled_instant", "progress_at", "claimed_at"):
                    e[k] = ts(e[k])
                e["ledger_missed"] = "scheduled_instant" in cols   # this store books missed slots itself
                execs.append(e)
        except sqlite3.OperationalError:
            pass
    return jobs, execs


def load_incidents() -> list[dict]:
    """Hermes' cron incident ledger: one row per job + normalised error, with a lifecycle
    detected → alerted → resolved (ran OK again) / closed (operator acknowledged)."""
    db = CRON_INCIDENTS.get()
    if db is None:
        return []
    try:
        rows = db.execute("select * from cron_incidents order by last_seen_at desc limit 200").fetchall()
    except sqlite3.OperationalError:
        return []
    out = []
    for r in rows:
        d = dict(r)
        for k in ("first_seen_at", "last_seen_at", "acked_at", "alerted_at", "closed_at"):
            d[k] = ts(d.get(k))
        d["error"] = short(d.get("error"), 240)
        d["open"] = d.get("state") in ("detected", "alerted")
        out.append(d)
    return out


def load_deliveries() -> dict:
    """Hermes' cron delivery queue: results waiting to reach their chat, and those that failed."""
    db = CRON_DELIVERIES.get()
    empty = {"pending": 0, "delivering": 0, "failed": 0, "delivered": 0, "unknown": 0, "suppressed": 0, "recent": []}
    if db is None:
        return empty
    try:
        counts = dict(db.execute("select status, count(*) from deliveries group by 1").fetchall())
        recent = [dict(r) for r in db.execute("select execution_id, status, for_failure, created_at, finished_at, error, job_json "
                                               "from deliveries where status in ('pending','delivering','failed') "
                                               "order by created_at desc limit 20")]
    except sqlite3.OperationalError:
        return empty
    for r in recent:
        try:
            r["job"] = (json.loads(r.pop("job_json") or "{}") or {}).get("name")
        except Exception:
            r["job"] = None
        r["created_at"], r["finished_at"] = ts(r.get("created_at")), ts(r.get("finished_at"))
        r["error"] = short(r.get("error"), 160)
    return {**empty, **counts, "recent": recent}


LOG_TS = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")


def tail_lines(path: Path, max_bytes: int = 256_000) -> list[str]:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            return f.read().decode("utf-8", "replace").splitlines()
    except FileNotFoundError:
        return []


def log_line_ts(line: str) -> Optional[float]:
    m = LOG_TS.match(line)
    if not m:
        return None
    return datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()


# ----------------------------------------------------------------- session status
def session_status(s: dict, now: float, digest: dict) -> str:
    if s["ended_at"] is None:
        if digest.get("final_reply"):
            return "waiting"                    # turn finished, the session is open and waits for the human
        idle = now - (s["last_activity_at"] or s["started_at"] or 0)
        return "running" if idle <= STALE_AFTER else "stale"
    reason = s.get("end_reason") or ""
    if reason in ORPHAN_REASONS:
        return "orphaned"
    if digest.get("tool_errors", 0) and digest.get("finish") == "tool_calls":
        return "failed"
    if reason in USER_CLOSE_REASONS:
        return "ended_by_user"
    return "ended"


def context_gauge(s: dict) -> Optional[dict]:
    """How full the model's context window was at the last API call (AionUi-style usage indicator)."""
    pt = s.get("prompt_tokens")
    if not pt:
        return None
    lim = s.get("context_limit") or CONTEXT_LENGTH
    return {"prompt_tokens": pt, "limit": lim, "pct": round(100 * pt / lim, 1), "assumed": lim == CONTEXT_LENGTH}


# ----------------------------------------------------------------- builders
def build_graph(hours: float, at: Optional[float]) -> dict:
    db = STATE.get()
    if db is None:
        return {"error": "state.db not found", "nodes": [], "links": [], "stats": {}}
    now = time.time()
    end = at if at else now
    start = 0 if hours <= 0 else end - hours * 3600

    # replay: only segments that existed by `at` take part, so a lineage's tip is the segment live then
    rows = [s for s in load_sessions(db) if (s["started_at"] or 0) <= end]
    logical, alias = logical_sessions(rows)
    sel = []
    for s in logical:
        st = s["started_at"] or 0
        last = s["last_activity_at"] or st
        if at is not None:                      # replay: only what existed by then
            if last < start and (s["ended_at"] or 0) < start:
                continue
        elif last < start:
            continue
        sel.append(s)
    ids = [s["id"] for s in sel]                # logical ids (= root segment ids)
    id_set = set(ids)
    seg_ids = [seg for s in sel for seg in s["segments"]]
    digests = load_messages(db, seg_ids, upto=at, group=alias)
    usage = load_usage(db, seg_ids)
    per_session_usage = session_usage(db, seg_ids, alias)
    todos = latest_todos(db, seg_ids)
    delegations = [d for d in load_delegations(db) if alias.get(d["origin_session"], d["origin_session"]) in id_set]
    for d in delegations:
        d["origin_session"] = alias.get(d["origin_session"], d["origin_session"])
    jobs, execs = load_cron()

    nodes: list[dict] = []
    links: list[dict] = []
    seen: set[str] = set()
    seen_links: set[tuple] = set()

    def add_node(nid: str, **attrs):
        if nid in seen:
            return
        seen.add(nid)
        nodes.append({"id": nid, **attrs})

    def add_link(src: str, dst: str, **attrs):
        if (src, dst) in seen_links:
            return
        seen_links.add((src, dst))
        links.append({"source": src, "target": dst, **attrs})

    add_node("hermes", type="hub", label="Hermes", val=40)

    for s in sel:
        src = s.get("source") or "unknown"
        add_node(f"src:{src}", type="source", label=src, val=14)
        add_link("hermes", f"src:{src}", kind="platform")

    for m, u in usage.items():
        add_node(f"model:{m}", type="model", label=m, val=8 + 2 * math.log1p((u["input"] + u["output"]) / 1e5),
                 tokens_in=u["input"], tokens_out=u["output"], cache_read=u["cache_read"], cache_hit=u["cache_hit"],
                 cache_write=u["cache_write"], reasoning=u["reasoning"],
                 calls=u["calls"], cost_usd=u["cost_usd"], cost_basis=u["cost_basis"], providers=u["providers"])

    counts = {"running": 0, "waiting": 0, "stale": 0, "active": 0, "orphaned": 0, "failed": 0, "errors": 0,
              "tool_calls": 0, "subagents": 0}
    # a subagent's parent may be any segment of a lineage: resolve it to the logical id
    for s in sel:
        p = s.get("parent_session_id")
        s["parent_session_id"] = alias.get(p, p) if p else None
    children: dict[str, int] = {}
    for s in sel:
        p = s.get("parent_session_id")
        if p in id_set:
            children[p] = children.get(p, 0) + 1

    for s in sel:
        sid = s["id"]
        d = digests.get(sid, {})
        last = d.get("last_ts") or s["last_activity_at"] or s["started_at"] or 0
        if at is not None:                      # replay: derive running/ended as of `at`
            s = dict(s)
            if s["ended_at"] and s["ended_at"] > at:
                s["ended_at"] = None
            s["last_activity_at"] = last
        status = session_status(s, end, d)
        active = (end - last) <= ACTIVE_WINDOW and status in ("running", "stale")
        is_sub = is_subagent(s, id_set)
        counts["active"] += active
        counts[status] = counts.get(status, 0) + 1 if status in counts else counts.get(status, 0)
        counts["errors"] += d.get("tool_errors", 0)
        counts["tool_calls"] += d.get("tool_calls", 0)
        counts["subagents"] += is_sub
        recent = [t for t in d.get("recent_calls", []) if end - t <= 60]
        age = end - last
        add_node(
            f"session:{sid}", type="subagent" if is_sub else "session", label=short(s["title"], 70),
            source=s.get("source"), model=s.get("model"), status=status, active=active,
            started=s["started_at"], ended=s["ended_at"], last=last, age=age,
            request=d.get("request"), last_step=d.get("last_step") or short(s.get("last_activity_description"), 140) or None,
            messages=s.get("message_count") or 0, user_messages=d.get("user_messages", 0),
            tool_calls=d.get("tool_calls", 0), tool_errors=d.get("tool_errors", 0),
            calls_per_min=len(recent), children=children.get(sid, 0), end_reason=s.get("end_reason"),
            parent=s.get("parent_session_id") if s.get("parent_session_id") in id_set else None,
            fork=s.get("fork"), usage=per_session_usage.get(sid),
            context=context_gauge(s), files=d.get("files", [])[-40:],
            segments=s["segments"], compactions=s["compactions"], tip=s["tip_id"],
            compacted_at=[t for t in s["compacted_at"] if t],
            cwd=s.get("cwd"), git_branch=s.get("git_branch"), profile=s.get("profile_name"),
            archived=bool(s.get("archived")), handoff=s.get("handoff_state"), user=s.get("user_id"),
            plan=plan_of(todos, s["segments"]),
            val=3 + math.log1p(s.get("message_count") or 0),
        )
        parent = s.get("parent_session_id")
        if parent and parent in id_set:
            deleg = next((x for x in delegations if x["origin_session"] == parent and x["dispatched_at"]
                          and abs(x["dispatched_at"] - (s["started_at"] or 0)) < 120), None)
            add_link(f"session:{parent}", f"session:{sid}", kind="branch" if s.get("fork") == "branch" else "spawn",
                     active=active, age=age, state=(deleg or {}).get("state"), delivery=(deleg or {}).get("delivery_state"),
                     goal=(deleg or {}).get("goal"))
        else:
            add_link(f"src:{s.get('source') or 'unknown'}", f"session:{sid}", kind="session", active=active, age=age)
        if s.get("model"):
            add_node(f"model:{s['model']}", type="model", label=s["model"], val=8)
            add_link(f"session:{sid}", f"model:{s['model']}", kind="model", active=active, age=age)
        # per-session tool ring
        for name, tool in d.get("tools", {}).items():
            tid = f"tool:{sid}:{name}"
            t_age = end - tool["last"]
            add_node(tid, type="tool", label=name, session=sid, calls=tool["calls"], errors=tool["errors"],
                     last=tool["last"], age=t_age, val=2 + math.log1p(tool["calls"]),
                     active=(end - tool["last"]) <= ACTIVE_WINDOW)
            add_link(f"session:{sid}", tid, kind="tool", value=tool["calls"], errors=tool["errors"], age=t_age,
                     active=(end - tool["last"]) <= ACTIVE_WINDOW)

    if jobs:
        add_node("src:cron", type="source", label="cron", val=14)
        add_link("hermes", "src:cron", kind="platform")
    last_exec: dict[str, dict] = {}
    for e in execs:
        if at is not None and (e["started_at"] or 0) > at:
            continue
        last_exec.setdefault(e["job_id"], e)
    for j in jobs:
        jid = j.get("id")
        e = last_exec.get(jid)
        last_run = (e or {}).get("finished_at") or (e or {}).get("started_at")
        add_node(f"cron:{jid}", type="cron", label=j.get("name") or jid,
                 schedule=j.get("schedule_display") or (j.get("schedule") or {}).get("display"),
                 next_run=ts(j.get("next_run_at") or j.get("next_run")), no_agent=bool(j.get("no_agent")),
                 script=j.get("script"), paused=bool(j.get("paused")), last_status=(e or {}).get("status"),
                 last_run=last_run, last_error=short((e or {}).get("error"), 140), age=(end - (last_run or 0)),
                 status="failed" if (e or {}).get("status") in ("failed", "error") else "ok", val=6)
        add_link("src:cron", f"cron:{jid}", kind="cron", age=end - (last_run or 0),
                 active=bool(last_run) and (end - last_run) <= ACTIVE_WINDOW)

    # every segment id of every drawn lineage → its node id, so #session:<any segment> deep links resolve
    aliases = {f"session:{seg}": f"session:{s['id']}" for s in sel for seg in s["segments"] if seg != s["id"]}
    return {
        "generated_at": now, "as_of": end, "window_hours": hours, "replay": at is not None,
        "stats": {"sessions": len(sel), **counts, "cron_jobs": len(jobs),
                  "compactions": sum(s["compactions"] for s in sel),
                  "cron_runs": sum(1 for e in execs if (e["finished_at"] or e["started_at"] or 0) >= start)},
        "nodes": nodes, "links": links, "aliases": aliases,
    }


def build_now() -> dict:
    db = STATE.get()
    if db is None:
        return {"running": [], "generated_at": time.time()}
    now = time.time()
    logical, alias = logical_sessions(load_sessions(db))
    sessions = [s for s in logical if s["ended_at"] is None]      # a lineage is open when its tip is
    for s in sessions:
        p = s.get("parent_session_id")
        s["parent_session_id"] = alias.get(p, p) if p else None
    ids = [s["id"] for s in sessions]
    open_segs = [seg for s in sessions for seg in s["segments"]]
    digests = load_messages(db, open_segs, upto=None, group=alias)
    todos = latest_todos(db, open_segs)
    id_set = set(ids)
    children: dict[str, list] = {}
    for s in sessions:
        p = s.get("parent_session_id")
        if p in id_set:
            children.setdefault(p, []).append(s["id"])
    running = []
    for s in sessions:
        d = digests.get(s["id"], {})
        last = d.get("last_ts") or s["last_activity_at"] or s["started_at"] or 0
        status = session_status(s, now, d)
        if status == "stale" and now - last > 6 * 3600:
            continue   # ancient orphans are noise
        if status == "waiting" and now - last > 48 * 3600:
            continue   # a chat nobody has touched for two days is not "your turn" any more
        recent = [t for t in d.get("recent_calls", []) if now - t <= 60]
        running.append({
            "id": s["id"], "title": short(s["title"], 80), "source": s.get("source"), "model": s.get("model"),
            "status": status, "started": s["started_at"], "last": last, "elapsed": now - (s["started_at"] or now),
            "idle": now - last, "request": d.get("request"),
            "last_step": d.get("last_step") or short(s.get("last_activity_description"), 140) or None,
            "tool_calls": d.get("tool_calls", 0), "tool_errors": d.get("tool_errors", 0),
            "calls_per_min": len(recent), "children": len(children.get(s["id"], [])),
            "is_subagent": is_subagent(s, id_set),
            "parent": s.get("parent_session_id"), "context": context_gauge(s),
            "compactions": s["compactions"], "tip": s["tip_id"],
            "cwd": s.get("cwd"), "git_branch": s.get("git_branch"), "plan": plan_of(todos, s["segments"]),
        })
    order = {"running": 0, "waiting": 1, "stale": 2}
    running.sort(key=lambda r: (order.get(r["status"], 3), -(r["last"] or 0)))
    return {"generated_at": now, "running": running}


def build_status() -> dict:
    now = time.time()
    db = STATE.get()
    checks: list[dict] = []

    def check(name: str, level: str, detail: str, **extra):
        checks.append({"name": name, "level": level, "detail": detail, **extra})

    # gateway heartbeat
    hb_age = None
    if db is not None:
        try:
            r = db.execute("select max(last_heartbeat) hb from gateway_heartbeats").fetchone()
            hb = ts(r["hb"]) if r else None
            hb_age = (now - hb) if hb else None
        except sqlite3.OperationalError:
            pass
    if hb_age is None:
        check("gateway", "red", "no heartbeat recorded")
    elif hb_age < 120:
        check("gateway", "green", f"heartbeat {int(hb_age)}s ago", age=hb_age)
    elif hb_age < 900:
        check("gateway", "amber", f"heartbeat {int(hb_age // 60)}m ago", age=hb_age)
    else:
        check("gateway", "red", f"no heartbeat for {int(hb_age // 60)}m", age=hb_age)

    # telegram transport (from gateway.log)
    tg_lines = [l for l in tail_lines(DATA / "logs" / "gateway.log")
                if "[Telegram]" in l and re.search(r"Connected to Telegram|recovered|failed|Disconnected|lost", l)]
    if not tg_lines:
        check("telegram", "amber", "no transport events in log")
    else:
        last_l = tg_lines[-1]
        when = log_line_ts(last_l)
        ok = bool(re.search(r"Connected to Telegram|recovered", last_l))
        check("telegram", "green" if ok else "amber",
              ("connected" if ok else "transport trouble") + (f" ({int((now - when) // 60)}m ago)" if when else ""),
              last=short(last_l.split("[Telegram]")[-1], 120))

    # cron: scheduler heartbeat, missed triggers, last run
    jobs, execs = load_cron()
    sched = scheduler_state(now)
    incidents = load_incidents()
    details = cron_jobs_detail(jobs, execs, now, incidents)
    missed = [j["name"] for j in details if j["missed"]]
    open_inc = [i for i in incidents if i["open"]]
    deliveries = load_deliveries()
    stuck = deliveries["pending"] + deliveries["delivering"] + deliveries["failed"]
    if not jobs:
        check("cron", "amber", "no jobs defined")
    elif sched["age"] is not None and sched["age"] > 900:
        check("cron", "red", f"scheduler silent for {int(sched['age'] // 60)}m ({len(jobs)} job(s))")
    elif open_inc:
        names = {j["id"]: j["name"] for j in details}
        check("cron", "red", f"{len(open_inc)} open incident(s): " + ", ".join(dict.fromkeys(names.get(i['job_id'], i['job_id']) for i in open_inc[:3])),
              incidents=[{"job": names.get(i["job_id"], i["job_id"]), "error": i["error"]} for i in open_inc[:3]])
    elif missed:
        check("cron", "red", f"missed trigger: {', '.join(missed[:3])}")
    elif stuck:
        check("cron", "amber", f"{stuck} result(s) not delivered ({deliveries['failed']} failed)")
    else:
        last = execs[0] if execs else None
        failed = [e for e in execs[:20] if e["status"] in ("failed", "error")]
        if last is None:
            check("cron", "amber", f"{len(jobs)} job(s), never run")
        elif failed and failed[0] is last:
            check("cron", "red", f"last run failed: {short(last.get('error'), 80)}")
        else:
            age = now - (last["finished_at"] or last["started_at"] or now)
            check("cron", "green" if not failed else "amber",
                  f"last run {last['status']} {int(age // 3600)}h ago" + (f", {len(failed)} recent failure(s)" if failed else ""))

    # error log (last hour)
    err_lines = []
    for l in tail_lines(DATA / "logs" / "errors.log"):
        t = log_line_ts(l)
        if t and now - t <= 3600 and re.search(r" (ERROR|CRITICAL|WARNING) ", l):
            err_lines.append(l)
    n_err = sum(1 for l in err_lines if re.search(r" (ERROR|CRITICAL) ", l))
    n_warn = len(err_lines) - n_err
    level = "red" if n_err >= 5 else "amber" if (n_err or n_warn >= 10) else "green"
    check("errors", level, f"{n_err} errors, {n_warn} warnings in the last hour",
          recent=[short(l, 160) for l in err_lines[-3:]], errors=n_err, warnings=n_warn)

    # orphaned / failed sessions in last 24h
    orphans = stale = running = waiting = 0
    if db is not None:
        recent = [s for s in load_sessions(db) if now - (s["last_activity_at"] or s["started_at"] or 0) <= 86400]
        orphans = sum(1 for s in recent if s.get("end_reason") in ORPHAN_REASONS)
        open_ = [s for s in recent if s["ended_at"] is None]
        digests = load_messages(db, [s["id"] for s in open_], upto=None)     # one query for all open sessions
        for s in open_:
            st = session_status(s, now, digests.get(s["id"], {}))
            if st == "waiting":
                waiting += 1
            elif st == "running":
                running += 1
            else:
                stale += 1
    check("sessions", "amber" if orphans else "green",
          f"{running} running, {waiting} waiting for you, {stale} stale, {orphans} orphaned (24h)")

    worst = "red" if any(c["level"] == "red" for c in checks) else "amber" if any(c["level"] == "amber" for c in checks) else "green"
    return {"generated_at": now, "level": worst, "checks": checks, "links": dashboard_links()}


def dashboard_links() -> Optional[dict]:
    """Deep links into the Hermes dashboard, if HERMES_DASHBOARD_URL says where it is.
    `chat_resume` + a session id opens that conversation in the dashboard's chat page."""
    if not DASHBOARD_URL:
        return None
    return {"home": DASHBOARD_URL, "chat_resume": DASHBOARD_URL + "/chat?resume=", "sessions": DASHBOARD_URL + "/sessions",
            "cron": DASHBOARD_URL + "/cron", "logs": DASHBOARD_URL + "/logs", "analytics": DASHBOARD_URL + "/analytics"}


def parse_todo(content: Any) -> Optional[dict]:
    """A todo_list tool result → {items, summary}; None when it is not a valid list."""
    try:
        d = json.loads(content) if isinstance(content, str) else content
    except Exception:
        return None
    if not isinstance(d, dict) or not isinstance(d.get("todos"), list):
        return None
    items = []
    for it in d["todos"]:
        if not isinstance(it, dict):
            continue
        items.append({"id": str(it.get("id", "?")), "content": short(it.get("content"), 300),
                      "status": it.get("status") if it.get("status") in ("pending", "in_progress", "completed", "cancelled") else "pending",
                      "parent": it.get("parent")})
    summary = {s: sum(1 for i in items if i["status"] == s) for s in ("pending", "in_progress", "completed", "cancelled")}
    summary["total"] = len(items)
    current = next((i["content"] for i in items if i["status"] == "in_progress"), None)
    return {"items": items, "summary": summary, "current": current, "revision": d.get("revision")}


def latest_todos(db, session_ids: list[str]) -> dict[str, dict]:
    """Newest todo_list result per session: the plan the agent is working through. Live rows
    first; a compacted copy counts when the live transcript no longer holds one (Hermes does the
    same when it restores a plan on resume)."""
    if not session_ids:
        return {}
    cols = table_columns(db, "messages")
    live = "active = 1 or compacted = 1" if "active" in cols else "1 = 1"
    q = ",".join("?" * len(session_ids))
    names = ",".join("?" * len(TODO_TOOLS))
    try:
        rows = db.execute(
            f"select session_id, content, timestamp from messages where id in ("
            f"  select max(id) from messages where session_id in ({q}) and tool_name in ({names}) and role = 'tool' "
            f"  and ({live}) group by session_id)", (*session_ids, *TODO_TOOLS)).fetchall()
    except sqlite3.OperationalError:
        return {}
    out = {}
    for r in rows:
        todo = parse_todo(r["content"])
        if todo:
            todo["ts"] = ts(r["timestamp"])
            out[r["session_id"]] = todo
    return out


def plan_of(todos: dict[str, dict], segments: list[str]) -> Optional[dict]:
    """The lineage's newest plan, as a compact badge for a node: done/total and the current step."""
    best = max((todos[s] for s in segments if s in todos), key=lambda t: t["ts"] or 0, default=None)
    if not best:
        return None
    s = best["summary"]
    return {"done": s["completed"], "total": s["total"], "open": s["pending"] + s["in_progress"],
            "current": short(best["current"], 120), "ts": best["ts"]}


def build_todo(sid: str) -> dict:
    db = STATE.get()
    if db is None:
        return {"error": "no state db"}
    logical, alias = logical_sessions(load_sessions(db))
    ls = next((x for x in logical if x["id"] == alias.get(sid, sid)), None)
    segs = ls["segments"] if ls else [sid]
    todos = latest_todos(db, segs)
    best = max(todos.values(), key=lambda t: t["ts"] or 0, default=None)
    return {"session": alias.get(sid, sid), "segments": segs, "todo": best}


def scheduler_state(now: float) -> dict:
    """Hermes' cron ticker writes '<epoch> <pid>' to cron/ticker_heartbeat every tick."""
    hb = None
    try:
        hb = float((DATA / "cron" / "ticker_heartbeat").read_text().split()[0])
    except Exception:
        pass
    return {"heartbeat": hb, "age": (now - hb) if hb else None, "alive": bool(hb) and (now - hb) < 900}


def cron_jobs_detail(jobs: list[dict], execs: list[dict], now: float, incidents: Optional[list[dict]] = None) -> list[dict]:
    by_job: dict[str, list[dict]] = {}
    for e in execs:
        by_job.setdefault(e["job_id"], []).append(e)
    inc_by_job: dict[str, list[dict]] = {}
    for i in incidents or []:
        inc_by_job.setdefault(i["job_id"], []).append(i)
    out = []
    for j in jobs:
        jid = j.get("id")
        hist = by_job.get(jid, [])[:20]
        next_run = ts(j.get("next_run_at"))
        last_run = ts(j.get("last_run_at")) or ((hist[0].get("finished_at") or hist[0].get("started_at")) if hist else None)
        enabled = bool(j.get("enabled", True)) and not j.get("paused_at")
        if hist and hist[0]["ledger_missed"]:
            # current Hermes books every slot it could not fire as a `missed` execution row; the job
            # has a missed trigger when its newest ledger row is one (a later run clears it)
            missed = enabled and hist[0]["status"] == "missed"
            missed_count = sum(1 for e in hist if e["status"] == "missed")
        else:
            # older stores: the scheduled instant is well past and nothing ran for it
            missed = enabled and next_run is not None and now - next_run > 600 \
                and not any((e.get("started_at") or 0) >= next_run - 60 for e in hist)
            missed_count = int(missed)
        ld = j.get("last_dispatch") or {}
        open_incidents = [i for i in inc_by_job.get(jid, []) if i["open"]]
        running = next((e for e in hist if e["status"] == "running"), None)
        state = "paused" if not enabled else \
            "running" if running else \
            "error" if open_incidents or (j.get("failure_streak") or 0) > 0 or j.get("last_status") in ("failed", "error") else \
            "missed" if missed else "scheduled"
        out.append({
            "id": jid, "name": j.get("name") or jid, "schedule": j.get("schedule_display") or (j.get("schedule") or {}).get("display"),
            "kind": (j.get("schedule") or {}).get("kind"), "state": state, "enabled": bool(j.get("enabled", True)),
            "paused_reason": j.get("paused_reason"), "mode": f"script: {j['script']}" if j.get("script") else "agent prompt",
            "prompt": short(j.get("prompt"), 160), "deliver": j.get("deliver"), "model": j.get("model"),
            "next_run": next_run, "last_run": last_run, "last_status": j.get("last_status"),
            "last_error": short(j.get("last_error"), 200), "failure_streak": j.get("failure_streak") or 0,
            "completed": (j.get("repeat") or {}).get("completed"), "lateness": ld.get("lateness_seconds"),
            "missed": missed, "missed_count": missed_count, "created_at": ts(j.get("created_at")),
            "timezone": j.get("timezone"), "catch_up": j.get("catch_up"),
            "progress_at": running["progress_at"] if running else None,
            "incidents": [{"id": i["id"], "state": i["state"], "type": i.get("failure_type"), "error": i["error"],
                           "first_seen": i["first_seen_at"], "last_seen": i["last_seen_at"], "open": i["open"]}
                          for i in inc_by_job.get(jid, [])[:5]],
            "history": [{"status": e.get("status"), "started": e.get("started_at"), "finished": e.get("finished_at"),
                         "scheduled": e.get("scheduled_instant"),
                         "duration": ((e.get("finished_at") or 0) - (e.get("started_at") or 0)) if e.get("finished_at") and e.get("started_at") else None,
                         "delivery": e.get("delivery_outcome"), "error": short(e.get("error"), 160)} for e in hist],
        })
    return out


def build_tasks() -> dict:
    """AionUi-style task board: async delegations (what subagents were asked to do) + scheduled jobs."""
    now = time.time()
    db = STATE.get()
    delegations: list[dict] = []
    if db is not None:
        sessions = load_sessions(db)
        titles = {s["id"]: s for s in sessions}
        try:
            rows = db.execute("select delegation_id, origin_session, parent_session_id, state, delivery_state, "
                              "delivery_attempts, dispatched_at, completed_at, updated_at, task_json, result_json "
                              "from async_delegations order by dispatched_at desc limit 200").fetchall()
        except sqlite3.OperationalError:
            rows = []
        for r in rows:
            d = dict(r)
            try:
                task = json.loads(d.pop("task_json") or "{}")
            except Exception:
                task = {}
            try:
                res = json.loads(d.pop("result_json") or "{}")
            except Exception:
                res = {}
            disp, done = ts(d.get("dispatched_at")), ts(d.get("completed_at"))
            parent = d.get("parent_session_id") or d.get("origin_session")
            kids = [s for s in sessions if s.get("parent_session_id") == parent and disp
                    and abs((s["started_at"] or 0) - disp) < 120]
            goals = task.get("goals") or ([task.get("goal")] if task.get("goal") else [])
            results = res if isinstance(res, list) else res.get("results") if isinstance(res, dict) else None
            summary = None
            if isinstance(results, list):
                summary = f"{len(results)} result(s)"
            elif isinstance(res, dict):
                summary = short(res.get("summary") or res.get("result") or res.get("error"), 200)
            delegations.append({
                "id": d["delegation_id"], "parent": parent, "parent_title": short(titles.get(parent, {}).get("title"), 60),
                "state": d.get("state"), "delivery": d.get("delivery_state"), "attempts": d.get("delivery_attempts"),
                "dispatched": disp, "completed": done, "updated": ts(d.get("updated_at")),
                "duration": (done - disp) if done and disp else (now - disp) if disp else None,
                "goal": short(task.get("goal"), 200), "goals": [short(g, 220) for g in goals][:8],
                "children": [{"id": s["id"], "title": short(s["title"], 60), "ended": s["ended_at"]} for s in kids],
                "summary": summary,
            })
    jobs, execs = load_cron()
    incidents = load_incidents()
    names = {j.get("id"): j.get("name") or j.get("id") for j in jobs}
    for i in incidents:
        i["job"] = names.get(i["job_id"], i["job_id"])
    return {"generated_at": now, "delegations": delegations, "jobs": cron_jobs_detail(jobs, execs, now, incidents),
            "scheduler": scheduler_state(now), "incidents": incidents[:50], "deliveries": load_deliveries()}


SECRET_RE = re.compile(r"(sk-[A-Za-z0-9_\-]{8,}|plf_[A-Za-z0-9]{6,}|\d{6,}:[A-Za-z0-9_\-]{20,}|bearer\s+\S+|token=\S+)", re.I)


def redact(text: str) -> str:
    return SECRET_RE.sub("[redacted]", text or "")


def build_diagnostics() -> dict:
    """Privacy-safe snapshot for bug reports (modelled on AionUi's feedback DB diagnostics):
    counts, states and identifiers only — no prompts, message content, keys or chat ids."""
    now = time.time()
    db = STATE.get()
    out: dict[str, Any] = {"generated_at": datetime.fromtimestamp(now, timezone.utc).isoformat(), "keryx": app.version,
                           "privacy": {"raw_content_included": False, "api_keys_included": False}}
    if db is not None:
        sessions = load_sessions(db)
        digests = load_messages(db, [s["id"] for s in sessions if s["ended_at"] is None], upto=None)
        by_status: dict[str, int] = {}
        for s in sessions:
            st = session_status(s, now, digests.get(s["id"], {}))
            by_status[st] = by_status.get(st, 0) + 1
        out["sessions"] = {"count": len(sessions), "by_status": by_status,
                           "by_source": _count(s.get("source") for s in sessions),
                           "by_model": _count(s.get("model") for s in sessions),
                           "end_reasons": _count(s.get("end_reason") for s in sessions if s.get("end_reason")),
                           "open": [{"id": s["id"], "source": s.get("source"), "model": s.get("model"),
                                     "status": session_status(s, now, digests.get(s["id"], {})),
                                     "messages": s.get("message_count"), "tool_calls": s.get("tool_call_count"),
                                     "prompt_tokens": s.get("prompt_tokens"), "idle_s": int(now - (s["last_activity_at"] or 0))}
                                    for s in sessions if s["ended_at"] is None][:20]}
        try:
            live = live_rows_sql(db)
            out["messages"] = {"by_role": dict(db.execute(f"select role, count(*) from messages where 1=1{live} group by 1").fetchall()),
                               "tool_calls_by_name": dict(db.execute(f"select tool_name, count(*) from messages where tool_name is not null{live} group by 1 order by 2 desc").fetchall())}
            out["delegations"] = {"by_state": dict(db.execute("select state || '/' || coalesce(delivery_state,'-'), count(*) from async_delegations group by 1").fetchall())}
            out["delivery_obligations"] = {"by_state": dict(db.execute("select state, count(*) from delivery_obligations group by 1").fetchall())}
            out["schema"] = {t: len(list(db.execute(f"pragma table_info({t})"))) for (t,) in db.execute("select name from sqlite_master where type='table'")}
        except sqlite3.OperationalError as e:
            out["schema_error"] = str(e)
    status = build_status()
    out["health"] = [{"name": c["name"], "level": c["level"], "detail": redact(c["detail"])} for c in status["checks"]]
    tasks = build_tasks()
    out["cron"] = {"scheduler": tasks["scheduler"],
                   "jobs": [{k: j[k] for k in ("id", "name", "schedule", "kind", "state", "enabled", "mode", "next_run", "last_run",
                                              "last_status", "failure_streak", "missed", "lateness")} | {"last_error": redact(j["last_error"] or "")}
                            for j in tasks["jobs"]]}
    errs = [redact(short(l, 200)) for l in tail_lines(DATA / "logs" / "errors.log") if re.search(r" (ERROR|CRITICAL) ", l)][-30:]
    out["recent_errors"] = errs
    out["data_files"] = {p.name: {"bytes": p.stat().st_size, "mtime": int(p.stat().st_mtime)}
                         for p in [DATA / "state.db", DATA / "state.db-wal", DATA / "cron" / "jobs.json", DATA / "cron" / "executions.db",
                                   DATA / "logs" / "errors.log", DATA / "logs" / "gateway.log"] if p.exists()}
    return out


def _count(it) -> dict:
    out: dict[str, int] = {}
    for v in it:
        k = str(v)
        out[k] = out.get(k, 0) + 1
    return out


def build_cost(hours: float) -> dict:
    db = STATE.get()
    now = time.time()
    if db is None:
        return {"models": [], "totals": {}}
    start = 0 if hours <= 0 else now - hours * 3600
    ids = [s["id"] for s in load_sessions(db) if (s["last_activity_at"] or s["started_at"] or 0) >= start]
    usage = load_usage(db, ids)
    models = sorted(usage.values(), key=lambda u: -(u["input"] + u["output"]))
    tot = {"input": sum(u["input"] for u in models), "output": sum(u["output"] for u in models),
           "cache_read": sum(u["cache_read"] for u in models), "calls": sum(u["calls"] for u in models),
           "cache_write": sum(u["cache_write"] for u in models), "reasoning": sum(u["reasoning"] for u in models),
           "cost_usd": round(sum(u["cost_usd"] for u in models), 4), "cost_basis": cost_basis_of(models)}
    denom = tot["input"] + tot["cache_read"]
    tot["cache_hit"] = round(tot["cache_read"] / denom, 3) if denom else 0.0
    return {"generated_at": now, "window_hours": hours, "models": models, "totals": tot}


def cost_basis_of(models: list[dict]) -> str:
    bases = {u["cost_basis"] for u in models if u.get("cost_usd")}
    if not bases:
        return next((u["cost_basis"] for u in models if u.get("cost_basis") == "included"), "unknown")
    return bases.pop() if len(bases) == 1 else "mixed"


# ----------------------------------------------------------------- analytics / trace / logs
def _day(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")


def build_analytics(days: int) -> dict:
    db = STATE.get()
    now = time.time()
    start = now - days * 86400
    if db is None:
        return {"days": [], "models": [], "totals": {}}
    sessions = [s for s in load_sessions(db) if (s["started_at"] or 0) >= start]
    ids = [s["id"] for s in sessions]
    per_day: dict[str, dict] = {}
    for i in range(days):
        per_day[_day(start + i * 86400 + 1)] = {"sessions": 0, "subagents": 0, "user_messages": 0, "tool_calls": 0,
                                                 "tool_errors": 0, "tokens_in": 0, "tokens_out": 0, "cache_read": 0}
    per_day.setdefault(_day(now), {"sessions": 0, "subagents": 0, "user_messages": 0, "tool_calls": 0,
                                   "tool_errors": 0, "tokens_in": 0, "tokens_out": 0, "cache_read": 0})
    day_of_session = {}
    for s in sessions:
        d = _day(s["started_at"])
        day_of_session[s["id"]] = d
        b = per_day.setdefault(d, dict.fromkeys(per_day[next(iter(per_day))].keys(), 0))
        b["sessions"] += 1
        if s.get("parent_session_id") or str(s["title"]).lower().startswith("subagent"):
            b["subagents"] += 1
    if ids:
        q = ",".join("?" * len(ids))
        for r in db.execute(f"select session_id, role, content, timestamp from messages where session_id in ({q}) "
                            f"and role in ('user','tool') and timestamp >= ?{live_rows_sql(db)}", (*ids, start)):
            t = ts(r["timestamp"]) or 0
            b = per_day.setdefault(_day(t), dict.fromkeys(per_day[next(iter(per_day))].keys(), 0))
            if r["role"] == "user":
                b["user_messages"] += 1
            else:
                b["tool_calls"] += 1
                if tool_result_failed(r["content"]):
                    b["tool_errors"] += 1
        try:
            for r in db.execute(f"select session_id, sum(input_tokens) i, sum(output_tokens) o, sum(cache_read_tokens) c "
                                f"from session_model_usage where session_id in ({q}) group by 1", ids):
                d = day_of_session.get(r["session_id"])
                if d and d in per_day:
                    per_day[d]["tokens_in"] += r["i"] or 0
                    per_day[d]["tokens_out"] += r["o"] or 0
                    per_day[d]["cache_read"] += r["c"] or 0
        except sqlite3.OperationalError:
            pass
    usage = load_usage(db, ids)
    models = sorted(usage.values(), key=lambda u: -(u["input"] + u["output"]))
    total_tok = sum(u["input"] + u["output"] for u in models) or 1
    for u in models:
        u["share"] = round((u["input"] + u["output"]) / total_tok, 4)
    days_list = [{"day": d, **v} for d, v in sorted(per_day.items())]
    active_days = sum(1 for v in per_day.values() if v["sessions"]) or 1
    tot = {
        "sessions": len(sessions), "subagents": sum(v["subagents"] for v in per_day.values()),
        "sessions_per_day": round(len(sessions) / days, 2), "active_days": active_days,
        "tool_calls": sum(v["tool_calls"] for v in per_day.values()), "tool_errors": sum(v["tool_errors"] for v in per_day.values()),
        "user_messages": sum(v["user_messages"] for v in per_day.values()),
        "tokens_in": sum(u["input"] for u in models), "tokens_out": sum(u["output"] for u in models),
        "cache_read": sum(u["cache_read"] for u in models), "api_calls": sum(u["calls"] for u in models),
        "cost_usd": round(sum(u["cost_usd"] for u in models), 4), "cost_basis": cost_basis_of(models),
        "cache_write": sum(u["cache_write"] for u in models), "reasoning": sum(u["reasoning"] for u in models),
    }
    denom = tot["tokens_in"] + tot["cache_read"]
    tot["cache_hit"] = round(tot["cache_read"] / denom, 3) if denom else 0.0
    busiest = max(days_list, key=lambda d: d["tool_calls"], default=None)
    tot["busiest_day"] = busiest["day"] if busiest and busiest["tool_calls"] else None
    return {"generated_at": now, "window_days": days, "days": days_list, "models": models, "totals": tot}


def _result_text(content: Any) -> str:
    try:
        d = json.loads(content) if isinstance(content, str) else content
    except Exception:
        return str(content or "")
    if isinstance(d, dict):
        if d.get("error"):
            return f"error: {d['error']}"
        return str(d.get("output") or d.get("result") or d.get("content") or json.dumps(d)[:400])
    return str(d)


def build_trace(sid: str, tool: Optional[str], limit: int) -> dict:
    db = STATE.get()
    if db is None:
        return {"error": "no state db"}
    # any segment id of a compression lineage resolves to the whole lineage, root → tip
    logical, alias = logical_sessions(load_sessions(db))
    ls = next((x for x in logical if x["id"] == alias.get(sid, sid)), None)
    if ls is None:
        srow = db.execute("select * from sessions where id = ?", (sid,)).fetchone()
        if not srow:
            return {"error": "session not found", "steps": []}
        ls = dict(srow)
        for k in ("started_at", "ended_at", "last_activity_at"):
            ls[k] = ts(ls.get(k))
        ls.update(segments=[sid], compactions=0, tip_id=sid, title=ls.get("title") or ls.get("display_name") or sid)
    s = ls
    segs = s["segments"]
    has_kind = "display_kind" in table_columns(db, "messages")
    kind_col = ", display_kind" if has_kind else ", null as display_kind"
    q = ",".join("?" * len(segs))
    rows = db.execute(f"select session_id, role, content, tool_name, tool_call_id, tool_calls, timestamp, finish_reason, token_count{kind_col} "
                      f"from messages where session_id in ({q}){live_rows_sql(db)}{hidden_rows_sql(db)} "
                      f"order by timestamp asc, id asc", segs).fetchall()
    steps: list[dict] = []
    pending: dict[str, dict] = {}
    seg_order = {x: i for i, x in enumerate(segs)}
    cur_seg = None
    for r in rows:
        t = ts(r["timestamp"]) or 0
        role = r["role"]
        if r["session_id"] != cur_seg:          # crossing into the next segment: the context was compacted here
            if cur_seg is not None and seg_order.get(r["session_id"], 0) > seg_order.get(cur_seg, 0):
                steps.append({"kind": "compaction", "ts": t, "text": f"context compacted · continued as session {r['session_id']}",
                              "segment": r["session_id"]})
            cur_seg = r["session_id"]
        dk = r["display_kind"] if has_kind else None
        if dk in EVENT_KINDS:                   # Hermes' own event rows: model switch, steer, auto-continue…
            steps.append({"kind": "event", "ts": t, "name": dk, "text": short(r["content"], 300)})
            continue
        if role == "user":
            steps.append({"kind": "user", "ts": t, "text": short(r["content"], 800)})
        elif role == "assistant":
            calls = []
            try:
                calls = json.loads(r["tool_calls"]) if r["tool_calls"] else []
            except Exception:
                calls = []
            for c in calls:
                fn = c.get("function", {}) if isinstance(c, dict) else {}
                step = {"kind": "tool_call", "ts": t, "name": fn.get("name") or c.get("name") or "?",
                        "args": short(fn.get("arguments") or "", 600), "id": c.get("call_id") or c.get("id"),
                        "result": None, "failed": None, "duration": None}
                steps.append(step)
                if step["id"]:
                    pending[step["id"]] = step
            if r["content"]:
                steps.append({"kind": "assistant", "ts": t, "text": short(r["content"], 800), "finish": r["finish_reason"]})
        elif role == "tool":
            step = pending.pop(r["tool_call_id"], None) if r["tool_call_id"] else None
            failed = tool_result_failed(r["content"])
            res = short(_result_text(r["content"]), 700)
            if step:
                step.update(result=res, failed=failed, duration=max(0.0, t - step["ts"]), result_ts=t,
                            name=step["name"] or r["tool_name"])
            else:
                steps.append({"kind": "tool_call", "ts": t, "name": r["tool_name"] or "tool", "args": "", "result": res,
                              "failed": failed, "duration": None})
    if tool:
        steps = [st for st in steps if st["kind"] == "tool_call" and st["name"] == tool]
    total = len(steps)
    usage = load_usage(db, segs)
    return {"session": {"id": s["id"], "title": s.get("title"), "source": s.get("source"),
                        "model": s.get("model"), "started": s["started_at"], "ended": s["ended_at"],
                        "end_reason": s.get("end_reason"), "messages": s.get("message_count"),
                        "segments": segs, "compactions": s["compactions"], "tip": s["tip_id"]},
            "usage": list(usage.values()), "steps": steps[-limit:], "total": total, "truncated": total > limit}


# display_kind values Hermes stamps on rows it paints as events rather than as chat turns
EVENT_KINDS = {"model_switch", "auto_continue", "steer", "async_delegation_complete", "process_complete",
               "skill_invocation", "personality_switch", "internal_notification"}


def log_files() -> dict[str, str]:
    """Every *.log in the Hermes logs directory, keyed by stem (errors, gateway, agent, audit, update…).
    Hermes adds log files over time, so the list is discovered rather than fixed."""
    out = {}
    try:
        for p in sorted((DATA / "logs").glob("*.log")):
            if p.is_file():
                out[p.stem] = p.name
    except OSError:
        pass
    return out


# the ones worth showing first when they exist
LOG_PRIORITY = ["errors", "gateway", "agent", "audit", "cron", "update", "container-boot", "gateway-restart", "dashboard-auth"]
LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
# Hermes' line format is "%(asctime)s %(levelname)s%(session_tag)s %(name)s: %(message)s" where the
# session tag is " [<session id>]" on every line logged inside a session and empty otherwise.
LOG_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:,\d+)? +(DEBUG|INFO|WARNING|ERROR|CRITICAL)"
                    r"(?: \[([^\]]*)\])? +([\w.\[\]-]+): ?(.*)$")


def parse_log_line(line: str) -> Optional[dict]:
    """One Hermes log line → {ts, level, logger, session, msg}; None for a continuation line."""
    m = LOG_RE.match(line)
    if not m:
        return None
    when, lvl, session, logger, msg = m.groups()
    return {"ts": log_line_ts(line), "level": lvl, "logger": logger, "session": session or None, "msg": msg}


def build_logs(file: str, level: str, q: str, lines: int) -> dict:
    files_map = log_files()
    name = files_map.get(file) or files_map.get("errors") or "errors.log"
    path = DATA / "logs" / name
    raw = tail_lines(path, 2_000_000)
    min_idx = LEVELS.index(level) if level in LEVELS else 0
    ql = (q or "").lower()
    out, counts = [], dict.fromkeys(LEVELS, 0)
    for line in raw:
        entry = parse_log_line(line)
        m = entry is not None
        if not m:
            entry = {"ts": None, "level": "INFO", "logger": "", "session": None, "msg": line}
            if out and out[-1].get("msg") is not None:   # continuation line (traceback)
                out[-1]["msg"] += "\n" + line
                continue
        counts[entry["level"]] = counts.get(entry["level"], 0) + 1
        if LEVELS.index(entry["level"]) < min_idx:
            continue
        if ql and ql not in line.lower():
            continue
        out.append(entry)
    files = []
    order = {k: i for i, k in enumerate(LOG_PRIORITY)}
    for key, fn in sorted(files_map.items(), key=lambda kv: (order.get(kv[0], 99), kv[0])):
        p = DATA / "logs" / fn
        if p.exists():
            st = p.stat()
            files.append({"key": key, "name": fn, "size": st.st_size, "mtime": st.st_mtime})
    return {"generated_at": time.time(), "file": name, "entries": out[-lines:], "matched": len(out), "counts": counts,
            "files": files}


# ----------------------------------------------------------------- cache + routes
_cache: dict[tuple, tuple] = {}
_cache_lock = threading.Lock()
# Builders run one at a time. The snapshot connections are shared across threads
# (check_same_thread=False), and Python's sqlite3 keeps a per-connection statement cache: two
# threads running the same SQL at once share one prepared statement, and one thread's reset
# scrambles the other's rows (seen as a session listed twice in a lineage). Reads take
# milliseconds, so serialising them costs nothing noticeable; cache hits never wait.
_build_lock = threading.RLock()


def cached(kind: str, builder, *args):
    key = (kind, *args, data_signature())
    with _cache_lock:
        hit = _cache.get(key)
        if hit:
            return hit
    with _build_lock:
        val = builder(*args)
    with _cache_lock:
        if len(_cache) > 64:
            _cache.clear()
        _cache[key] = val
    return val


@app.get("/api/health")
def api_health(request: Request):
    out = {"ok": True, "time": time.time(), "state_db": (DATA / "state.db").exists()}
    if authorised(request):
        out["data"] = str(DATA)
    return out


@app.get("/api/graph")
def api_graph(hours: float = Query(24, ge=0), at: Optional[float] = Query(None)):
    return cached("graph", build_graph, hours, at)


@app.get("/api/now")
def api_now():
    return cached("now", build_now)


@app.get("/api/status")
def api_status():
    return cached("status", build_status)


@app.get("/api/cost")
def api_cost(hours: float = Query(24, ge=0)):
    return cached("cost", build_cost, hours)


@app.get("/api/analytics")
def api_analytics(days: int = Query(30, ge=1, le=365)):
    return cached("analytics", build_analytics, days)


@app.get("/api/session/{sid}/trace")
def api_trace(sid: str, tool: Optional[str] = Query(None), limit: int = Query(300, ge=1, le=2000)):
    return cached("trace", build_trace, sid, tool, limit)


@app.get("/api/session/{sid}/todo")
def api_todo(sid: str):
    return cached("todo", build_todo, sid)


@app.get("/api/tasks")
def api_tasks():
    return cached("tasks", build_tasks)


@app.get("/api/diagnostics")
def api_diagnostics():
    with _build_lock:
        body = json.dumps(build_diagnostics(), indent=1, default=str)
    return Response(body, media_type="application/json",
                    headers={"Content-Disposition": f"attachment; filename=keryx-diagnostics-{int(time.time())}.json"})


@app.get("/api/qr")
def api_qr(text: str = Query(..., max_length=500)):
    """SVG QR code so the page can be opened on a phone (the WebUI login idea from AionUi)."""
    import io
    import segno
    buf = io.BytesIO()
    segno.make(text, error="m").save(buf, kind="svg", scale=6, dark="#14202e", light=None, xmldecl=False, svgclass=None, lineclass=None)
    return Response(buf.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "max-age=3600"})


@app.get("/api/logs")
def api_logs(file: str = Query("errors"), level: str = Query(""), q: str = Query(""), lines: int = Query(200, ge=1, le=2000)):
    return build_logs(file, level, q, lines)


def bundle(hours: float) -> dict:
    return {"graph": cached("graph", build_graph, hours, None), "now": cached("now", build_now),
            "status": cached("status", build_status), "cost": cached("cost", build_cost, hours),
            "tasks": cached("tasks", build_tasks)}


class Broadcaster:
    """One watcher for all SSE clients.

    Every client used to stat the data files itself every two seconds and build its own bundle on
    each change. Now a single task polls the signature, builds one bundle per distinct window the
    clients asked for, and hands the encoded event to every subscriber's queue. Starts lazily on
    the first subscription and stops when the last client leaves."""

    def __init__(self):
        self.subs: dict[float, set[asyncio.Queue]] = {}
        self.task: Optional[asyncio.Task] = None
        self.last: dict[float, str] = {}         # hours → last event text, replayed to a new subscriber

    async def subscribe(self, hours: float) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=4)
        self.subs.setdefault(hours, set()).add(q)
        if hours in self.last:
            q.put_nowait(self.last[hours])
        else:
            q.put_nowait(await self.render(hours))
        if self.task is None or self.task.done():
            self.task = asyncio.get_running_loop().create_task(self.run())
        return q

    def unsubscribe(self, hours: float, q: asyncio.Queue) -> None:
        subs = self.subs.get(hours)
        if subs:
            subs.discard(q)
            if not subs:
                del self.subs[hours]
                self.last.pop(hours, None)

    async def render(self, hours: float) -> str:
        payload = await asyncio.to_thread(bundle, hours)
        text = f"event: update\ndata: {json.dumps(payload)}\n\n"
        self.last[hours] = text
        return text

    async def run(self) -> None:
        last_sig, last_sent = data_signature(), time.time()
        while self.subs:
            await asyncio.sleep(2)
            sig, now = data_signature(), time.time()
            if sig == last_sig and now - last_sent <= 60:
                continue
            last_sig, last_sent = sig, now
            for hours in list(self.subs):
                text = await self.render(hours)
                for q in list(self.subs.get(hours, ())):
                    if q.full():                 # a slow client: drop its stale event, keep the newest
                        try:
                            q.get_nowait()
                        except asyncio.QueueEmpty:
                            pass
                    q.put_nowait(text)


BROADCAST = Broadcaster()


@app.get("/api/stream")
async def api_stream(hours: float = Query(24, ge=0)):
    """Server-sent events: one 'update' per data change, keepalive every 25 s."""
    async def gen():
        q = await BROADCAST.subscribe(hours)
        try:
            while True:
                try:
                    yield await asyncio.wait_for(q.get(), timeout=25)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            BROADCAST.unsubscribe(hours, q)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


if STATIC.exists():
    app.mount("/assets", StaticFiles(directory=STATIC / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        file = STATIC / path
        if path and file.is_file():
            return FileResponse(file)
        return FileResponse(STATIC / "index.html")
else:
    @app.get("/")
    def no_ui():
        return JSONResponse({"error": "frontend not built: run npm run build in frontend/"}, status_code=503)
