"""Keryx — Hermes activity graph, FastAPI backend.

Reads Hermes state (sqlite WAL) through snapshot copies keyed on file mtime, plus the
cron store and gateway logs, and exposes:
  GET /api/graph?hours=24[&at=<epoch>]   nodes/links (at = replay the graph as of that moment)
  GET /api/now                            running sessions with request + latest step
  GET /api/status                         health header (gateway, telegram, cron, errors, orphans)
  GET /api/cost?hours=24                  token/cost totals per model for the window
  GET /api/stream?hours=24                SSE: pushes {graph, now, status, cost, tasks} when data changes
  GET /api/tasks                          delegations board + scheduled jobs with run history
  GET /api/search?q=                      sessions whose conversation mentions q (Hermes' FTS5 index)
  GET /api/memory                         MEMORY.md / USER.md entries and budgets (only with KERYX_SHOW_MEMORY=1)
  GET /api/diagnostics                    redacted snapshot for bug reports (no prompts, no keys)
  GET /api/qr?text=                       QR code (SVG) for opening Keryx on a phone
  GET /api/health                         liveness
  /                                       the React app (static/)
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import difflib
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
# Opt-in: show Hermes' memory files (memories/MEMORY.md and USER.md) in a panel. They are personal notes
# about you and your environment, so the panel stays off unless this is set; the diagnostics bundle
# never includes them either way.
SHOW_MEMORY = os.environ.get("KERYX_SHOW_MEMORY", "").strip().lower() in ("1", "true", "yes", "on")
# Hermes separates memory entries with this (tools/memory_tool_store.ENTRY_DELIMITER)
MEMORY_DELIMITER = "\n§\n"
MEMORY_FILES = {"memory": "MEMORY.md", "user": "USER.md"}
MEMORY_DEFAULTS = {"memory_char_limit": 2200, "user_char_limit": 1375, "memory_enabled": True, "user_profile_enabled": True}
# Optional shared secret. When set, every /api/* route except /api/health needs it as a bearer
# header, a `keryx_token` cookie, or `?token=` (the page sets the cookie from the first).
TOKEN = os.environ.get("KERYX_TOKEN", "").strip()

# sessions Hermes runs for itself rather than for a conversation: one-shot CLI calls, tool-spawned
# helpers, kanban workers (hermes-desktop keeps them out of its conversation list for the same reason)
INTERNAL_SOURCES = {"oneshot", "tool", "kanban"}

# Hermes `sessions.end_reason` values, grouped by what they mean for the picture.
# Orphans: the gateway (or a websocket backend) came back and reaped a session it no longer owned.
ORPHAN_REASONS = {"startup_orphan_reap", "ws_orphan_reap"}
# Closed by the human rather than by the agent finishing: CLI/TUI exit, explicit reset, websocket gone.
USER_CLOSE_REASONS = {"cli_close", "tui_shutdown", "tui_close", "user_exit", "session_reset", "ws_disconnect"}
# The session was compacted: Hermes ends it and continues the same conversation in a child session.
COMPRESSION_REASON = "compression"

app = FastAPI(title="Keryx", version="2.6")


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


def plural(n: Any, word: str, pl: Optional[str] = None) -> str:
    """'1 job', '2 jobs', '1 incident', '3 results': proper plurals instead of 'job(s)' in user-facing text."""
    try:
        n = int(n or 0)
    except (TypeError, ValueError):
        n = 0
    return f"{n} {word if n == 1 else (pl or word + 's')}"


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
    _KANBAN.clear()
    with _cache_lock:
        _cache.clear()


def data_signature() -> tuple:
    return file_sig(DATA / "state.db", DATA / "state.db-wal", DATA / "cron" / "jobs.json",
                    DATA / "cron" / "executions.db", DATA / "cron" / "incidents.db", DATA / "cron" / "deliveries.db",
                    DATA / "logs" / "errors.log", DATA / "skills" / ".usage.json",
                    DATA / "memories" / "MEMORY.md", DATA / "memories" / "USER.md", DATA / "config.yaml",
                    DATA / "gateway_state.json", DATA / "kanban.db", DATA / "kanban.db-wal", DATA / "kanban" / "current",
                    DATA / "context_length_cache.yaml", DATA / "plugin-data" / "hermes-achievements" / "state.json")


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
    model_cfg = model_config_section()
    cache = load_context_cache()
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
            s["base_url"] = cfg.get("base_url") if isinstance(cfg.get("base_url"), str) else None
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
        s["context_limit"], s["context_source"] = context_limit(s.get("model"), s.get("base_url"), model_cfg, cache)
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


def context_limit(model: Optional[str], base_url: Optional[str] = None, model_cfg: Optional[dict] = None,
                  cache: Optional[dict] = None) -> tuple[int, str]:
    """The model's context window and where the number came from, in the order Hermes itself resolves it:
    an explicit `model.context_length` in config.yaml (for the configured default model), the window
    Hermes probed and cached in context_length_cache.yaml (keyed model@base_url), Keryx's small
    built-in table, and finally CONTEXT_LENGTH as a stated assumption."""
    model_cfg = model_config_section() if model_cfg is None else model_cfg
    cache = load_context_cache() if cache is None else cache
    m = (model or "").strip()
    explicit = model_cfg.get("context_length")
    if explicit and (not model_cfg.get("default") or not m or m == model_cfg["default"]):
        return explicit, "config"
    if m and cache:
        if base_url:
            for key in (f"{m}@{base_url.rstrip('/')}", f"{m}@{base_url}"):
                if cache.get(key):
                    return cache[key], "cache"
        hits = [v for k, v in cache.items() if k.startswith(m + "@") and v]
        if hits:
            return max(hits), "cache"
    ml = m.lower()
    for key, lim in CONTEXT_LIMITS.items():
        if key in ml:
            return lim, "table"
    return CONTEXT_LENGTH, "assumed"


def load_context_cache() -> dict[str, int]:
    """Hermes' context_length_cache.yaml (agent/model_metadata_cache.py): `context_lengths:` with one
    `model@base_url: tokens` line per probed model. Read with a line scanner, no YAML dependency."""
    out: dict[str, int] = {}
    try:
        lines = (DATA / "context_length_cache.yaml").read_text().splitlines()
    except OSError:
        return out
    inside = False
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            inside = line.split(":")[0].strip() == "context_lengths"
            continue
        if not inside or ":" not in line:
            continue
        key, _, val = line.strip().rpartition(":")
        key = key.strip().strip("'\"")
        try:
            n = int(val.split("#")[0].strip())
        except ValueError:
            continue
        if key and n > 0:
            out[key] = n
    return out


def model_config_section() -> dict:
    """`model:` in config.yaml: the default model, provider, base_url and an explicit context_length."""
    raw = config_section("model", {"default", "model", "provider", "base_url", "context_length"})
    out: dict[str, Any] = {"default": raw.get("default") or raw.get("model"), "provider": raw.get("provider"), "base_url": raw.get("base_url"),
                           "context_length": None}
    try:
        n = int(raw.get("context_length") or 0)
        out["context_length"] = n if n > 0 else None
    except ValueError:
        pass
    return out


def config_section(name: str, keys: set[str]) -> dict[str, str]:
    """Flat `key: value` pairs of one top-level section of config.yaml, read with a line scanner so
    Keryx needs no YAML dependency. Values come back as bare strings (quotes and comments stripped)."""
    out: dict[str, str] = {}
    try:
        lines = (DATA / "config.yaml").read_text().splitlines()
    except OSError:
        return out
    inside = False
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            inside = line.split(":")[0].strip() == name
            continue
        if not inside or ":" not in line:
            continue
        key, _, val = line.strip().partition(":")
        key = key.strip()
        if key in keys and key not in out:
            out[key] = val.split("#")[0].strip().strip("'\"")
    return out


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
            f = {"path": str(path), "op": op}
            d = diff_summary(name, args) if op in ("write", "patch") else None
            if d:
                f["added"], f["removed"] = d["added"], d["removed"]
            out.append(f)
    return out


def tool_call_names(tool_calls_json: Any) -> list[str]:
    try:
        calls = json.loads(tool_calls_json) if isinstance(tool_calls_json, str) else (tool_calls_json or [])
        return [c.get("function", {}).get("name") or c.get("name") or "?" for c in calls]
    except Exception:
        return []


# What a Hermes tool does, by name, for glyphs and the Changes filter of the reading view. Unknown
# names fall back to "other"; MCP tools (Hermes registers them with the server name prefixed) to "mcp".
TOOL_KINDS = {
    "terminal": "shell", "execute_code": "shell", "process_manage": "shell", "read_terminal": "shell", "close_terminal": "shell",
    "read_file": "read", "skill_view": "read", "read_window_below": "read",
    "search_files": "search", "session_search": "search", "skills_list": "search",
    "write_file": "write", "patch": "edit",
    "web_search": "web", "web_extract": "web", "x_search": "web",
    "browser_exec": "browser", "browser_cdp": "browser", "browser_dialog": "browser", "browser_vault": "browser",
    "delegate_task": "agent", "clarify": "ask", "todo_list": "todo", "todo": "todo", "memory": "memory",
    "vision_analyze": "media", "video_analyze": "media", "image_generate": "media", "video_generate": "media", "text_to_speech": "media",
    "cronjob_manage": "cron", "skill_manage": "skill", "send_message": "message", "react_to_message": "message",
}


def tool_kind(name: Optional[str]) -> str:
    n = name or ""
    if n in TOOL_KINDS:
        return TOOL_KINDS[n]
    return "mcp" if n.startswith("mcp_") or "__" in n else "other"


def parse_args(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        d = json.loads(raw) if raw else {}
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _first_line(text: Any, n: int = 120) -> str:
    for line in str(text or "").splitlines():
        if line.strip():
            return short(line, n)
    return ""


def step_title(name: str, args: dict) -> str:
    """One line that says what a tool call did: the command, the path, the query, the goal…
    (cc-switch's reading view distils every step the same way)."""
    kind = tool_kind(name)
    if kind == "shell":
        return _first_line(args.get("command") or args.get("code") or args.get("action") or "")
    if kind in ("read", "write", "edit", "search"):
        path = args.get("path") or args.get("file_path") or args.get("directory") or ""
        pat = args.get("pattern") or args.get("query")
        if pat and path:
            return short(f"{pat} in {path}", 120)
        return short(pat or path or args.get("name") or "", 120)
    if kind in ("web", "browser"):
        urls = args.get("urls")
        return short(args.get("query") or args.get("url") or (urls[0] if isinstance(urls, list) and urls else "")
                     or args.get("action") or "", 120)
    if kind == "agent":
        tasks = args.get("tasks")
        goals = [t.get("goal") for t in tasks if isinstance(t, dict) and t.get("goal")] if isinstance(tasks, list) else []
        goal = goals[0] if goals else args.get("goal") or ""
        more = f" (+{len(goals) - 1} more)" if len(goals) > 1 else ""
        return short(goal, 110) + more
    if kind == "ask":
        qs = args.get("questions")
        q = qs[0] if isinstance(qs, list) and qs else args.get("question") or ""
        return short(q.get("question") if isinstance(q, dict) else q, 120)
    if kind == "todo":
        todos = args.get("todos")
        return f"{len(todos)} items" if isinstance(todos, list) else ""
    if kind == "memory":
        return short(" ".join(str(args.get(k)) for k in ("action", "target") if args.get(k)), 120)
    for v in args.values():                       # anything else: the first string argument
        if isinstance(v, str) and v.strip():
            return _first_line(v)
    return ""


def diff_summary(name: str, args: dict) -> Optional[dict]:
    """Lines added/removed by a write_file or patch call, from its arguments: write_file carries the
    whole file, patch an old_string → new_string pair (counted with difflib, so a one-word edit in a
    ten-line block is 1/1, not 10/10)."""
    kind = tool_kind(name)
    path = args.get("path") or args.get("file_path")
    if kind == "write":
        content = args.get("content")
        if not isinstance(content, str) or not path:
            return None
        return {"op": "write", "path": str(path), "added": len(content.splitlines()), "removed": 0}
    if kind == "edit":
        old, new = args.get("old_string"), args.get("new_string")
        if not isinstance(new, str) or not path:
            return None
        a, b = str(old or "").splitlines(), new.splitlines()
        added = removed = 0
        for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
            if tag in ("replace", "delete"):
                removed += i2 - i1
            if tag in ("replace", "insert"):
                added += j2 - j1
        return {"op": "update", "path": str(path), "added": added, "removed": removed}
    return None


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


def has_json(db) -> bool:
    """SQLite built with the JSON1 functions (every Python since 3.9 ships one; guarded anyway)."""
    try:
        db.execute("select json_valid('{}')")
        return True
    except sqlite3.OperationalError:
        return False


# Hermes' own display rule (hermes_state_messages.DISPLAY_VISIBLE_SQL): a row whose display_metadata
# carries model_only is read by the model but was never typed as one message. Micro-compaction writes
# such a row when it merges adjacent user turns; the original turns stay visible, so painting the merge
# too shows the same request twice. json_valid guards rows whose metadata is not JSON at all.
MODEL_ONLY_SQL = ("coalesce(json_extract(case when json_valid(display_metadata) then display_metadata "
                  "else json_object() end, '$.model_only'), 0) = 0")


def hidden_rows_sql(db) -> str:
    """Skip the rows Hermes itself never paints: display_kind='hidden' scaffolding and model-only
    merges (see MODEL_ONLY_SQL). Older databases lack the columns; then nothing is hidden."""
    cols = table_columns(db, "messages")
    out = ""
    if "display_kind" in cols:
        out += " and coalesce(display_kind, '') <> 'hidden'"
    if "display_metadata" in cols and has_json(db):
        out += f" and {MODEL_ONLY_SQL}"
    return out


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
    src = s.get("context_source") or ("assumed" if lim == CONTEXT_LENGTH else "table")
    return {"prompt_tokens": pt, "limit": lim, "pct": round(100 * pt / lim, 1), "assumed": src == "assumed", "source": src}


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
    kb_index = kanban_session_index()       # worker sessions carry the kanban card they work on

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
            # Hermes' own flags: pinned in its session picker, hidden from it (hosted rooms, hidden branches)
            pinned=bool(s.get("pinned")), hidden=bool(s.get("hidden")), internal=(s.get("source") in INTERNAL_SOURCES),
            plan=plan_of(todos, s["segments"]),
            task=next((kb_index[x] for x in s["segments"] if x in kb_index), None),
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
    gw = gateway_summary(load_gateway_state(), now)
    if hb_age is None:
        level, detail = "red", "no heartbeat recorded"
    elif hb_age < 120:
        level, detail = "green", f"heartbeat {int(hb_age)}s ago"
    elif hb_age < 900:
        level, detail = "amber", f"heartbeat {int(hb_age // 60)}m ago"
    else:
        level, detail = "red", f"no heartbeat for {int(hb_age // 60)}m"
    extra: dict[str, Any] = {"age": hb_age}
    if gw:
        # Hermes' own account of the process (gateway_state.json) outranks the heartbeat table when it is
        # fresher and says something is wrong: a gateway can keep its heartbeat row while a platform
        # thread is dead, or sit in `degraded` after a partial start.
        extra.update(state=gw["state"], wanted=gw["desired"], version=gw["version"], pid=gw["pid"])
        if gw["stale"]:
            level = worst_of(level, "amber")
            detail += f" · state file {int(gw['age'] // 60)}m old"
        elif gw["level"] == "red":
            level, detail = "red", f"gateway {gw['state']}" + (f", wanted {gw['desired']}" if gw["desired"] and gw["desired"] != gw["state"] else "")
        elif gw["desired"] and gw["desired"] != gw["state"]:
            level = worst_of(level, "amber")
            detail = f"gateway {gw['state']}, wanted {gw['desired']} · " + detail
        elif gw["level"] == "amber":
            level = worst_of(level, "amber")
            detail = f"gateway {gw['state']} · " + detail
        if gw["restart_requested"]:
            level = worst_of(level, "amber")
            detail = "restart pending · " + detail
            extra["restart_requested"] = True
        if gw["version"]:
            detail += f" · Hermes {gw['version']}"
    check("gateway", level, detail, **extra)

    # platforms: one check per transport from gateway_state.json (hermes-desktop's Gateway screen reads
    # the same records); the gateway.log scrape is only the fallback for a Hermes that predates the file
    if gw and gw["platforms"]:
        for pf in gw["platforms"]:
            check(pf["name"], pf["level"], pf["detail"], kind="platform", state=pf["state"],
                  error_code=pf["error_code"], updated=pf["updated"], since=pf["since"])
    else:
        tg_lines = [l for l in tail_lines(DATA / "logs" / "gateway.log")
                    if "[Telegram]" in l and re.search(r"Connected to Telegram|recovered|failed|Disconnected|lost", l)]
        if not tg_lines:
            check("telegram", "amber", "no transport events in log", kind="platform")
        else:
            last_l = tg_lines[-1]
            when = log_line_ts(last_l)
            ok = bool(re.search(r"Connected to Telegram|recovered", last_l))
            check("telegram", "green" if ok else "amber",
                  ("connected" if ok else "transport trouble") + (f" ({int((now - when) // 60)}m ago)" if when else ""),
                  last=short(last_l.split("[Telegram]")[-1], 120), kind="platform")

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
        check("cron", "red", f"scheduler silent for {int(sched['age'] // 60)}m ({plural(len(jobs), 'job')})")
    elif open_inc:
        names = {j["id"]: j["name"] for j in details}
        check("cron", "red", f"{plural(len(open_inc), 'open incident')}: " + ", ".join(dict.fromkeys(names.get(i['job_id'], i['job_id']) for i in open_inc[:3])),
              incidents=[{"job": names.get(i["job_id"], i["job_id"]), "error": i["error"]} for i in open_inc[:3]])
    elif missed:
        check("cron", "red", f"missed trigger: {', '.join(missed[:3])}")
    elif stuck:
        check("cron", "amber", f"{plural(stuck, 'result')} not delivered ({deliveries['failed']} failed)")
    else:
        last = execs[0] if execs else None
        failed = [e for e in execs[:20] if e["status"] in ("failed", "error")]
        if last is None:
            check("cron", "amber", f"{plural(len(jobs), 'job')}, never run")
        elif failed and failed[0] is last:
            check("cron", "red", f"last run failed: {short(last.get('error'), 80)}")
        else:
            age = now - (last["finished_at"] or last["started_at"] or now)
            check("cron", "green" if not failed else "amber",
                  f"last run {last['status']} {int(age // 3600)}h ago" + (f", {plural(len(failed), 'recent failure')}" if failed else ""))

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

    # kanban: only when the board has tasks (an empty board is the normal state on most installs)
    kb = build_kanban()
    if kb["board"] is not None and kb["total"]:
        c = kb["counts"]
        open_ = kb["total"] - c.get("done", 0)
        silent = [a for a in kb["attention"] if a["why"] == "worker silent"]
        if silent:
            check("kanban", "red", f"{plural(len(silent), 'running task')} with a silent worker: " + ", ".join(a["title"] for a in silent[:3]),
                  board=kb["board"], counts=c)
        elif kb["attention"]:
            check("kanban", "amber", f"{plural(len(kb['attention']), 'task')} failing repeatedly: " + ", ".join(a["title"] for a in kb["attention"][:3]),
                  board=kb["board"], counts=c)
        elif c.get("blocked"):
            check("kanban", "amber", f"{c['blocked']} blocked · {c.get('running', 0)} running · {c.get('review', 0)} in review · {open_} open",
                  board=kb["board"], counts=c)
        else:
            check("kanban", "green", f"{c.get('running', 0)} running · {c.get('review', 0)} in review · {open_} open · {c.get('done', 0)} done",
                  board=kb["board"], counts=c)

    # storage: how big Hermes' data has grown and whether the disk under it has room (hermes-webui's
    # system panel shows disk use; the WAL size matters on its own: a WAL that keeps growing means
    # no checkpoint is landing, which is how a state.db ends up unreadable after a crash)
    st = storage_state()
    if st["free"] is not None and (st["free"] < 1 << 30 or st["free_pct"] < 5):
        check("storage", "red", f"{fmt_bytes(st['free'])} free on the data disk ({st['free_pct']}%)", **st)
    elif st["wal"] > 256 << 20:
        check("storage", "amber", f"WAL {fmt_bytes(st['wal'])} and growing: checkpoints are not landing", **st)
    elif st["free"] is not None and st["free"] < 5 << 30:
        check("storage", "amber", f"{fmt_bytes(st['free'])} free on the data disk", **st)
    else:
        check("storage", "green", f"state.db {fmt_bytes(st['db'])} · WAL {fmt_bytes(st['wal'])} · logs {fmt_bytes(st['logs'])}"
              + (f" · {fmt_bytes(st['free'])} free" if st["free"] is not None else ""), **st)

    worst = "red" if any(c["level"] == "red" for c in checks) else "amber" if any(c["level"] == "amber" for c in checks) else "green"
    attention = attention_list(checks, details, open_inc, missed, deliveries, kb, orphans, waiting)
    return {"generated_at": now, "level": worst, "checks": checks, "links": dashboard_links(), "attention": attention, "keryx": app.version,
            "hermes": {k: gw[k] for k in ("state", "desired", "level", "version", "sha", "pid", "started", "updated", "age", "stale",
                                           "profiles", "restart_requested")} if gw else None}


def attention_list(checks: list[dict], jobs: list[dict], open_inc: list[dict], missed: list[str], deliveries: dict,
                   kb: dict, orphans: int, waiting: int) -> list[dict]:
    """One ranked triage list out of everything that is red or amber (hermes-workspace's attention card):
    each item names what is wrong, where it came from and where to look (a node to select or a tab to
    open). Red first, then amber, then the one informational line: sessions waiting for you."""
    items: list[dict] = []
    by = {c["name"]: c for c in checks}

    def add(id_: str, sev: str, source: str, label: str, detail: str = "", node: Optional[str] = None, tab: Optional[str] = None):
        items.append({"id": id_, "severity": sev, "source": source, "label": label, "detail": detail or "", "node": node, "tab": tab})

    g = by.get("gateway")
    if g and g["level"] != "green":
        if g.get("restart_requested"):
            add("restart", "amber", "gateway", "restart pending", "the gateway flagged restart_requested; it restarts on its own schedule", tab="overview")
        core = g["detail"].replace("restart pending · ", "")
        if "heartbeat" in core and g["level"] == "red" or g["level"] == "red" or ("state file" in core or "gateway " in core):
            add("gateway", g["level"], "gateway", f"gateway: {core}", tab="overview")
    for c in checks:
        if c.get("kind") == "platform" and c["level"] != "green":
            add(f"platform-{c['name']}", c["level"], "platform", f"{c['name'].replace('_', ' ')} {c.get('state') or c['detail'].split(' ')[0]}",
                c["detail"], tab="overview")
    names = {j["id"]: j["name"] for j in jobs}
    seen_jobs: set[str] = set()
    for i in open_inc:
        if i["job_id"] in seen_jobs:
            continue
        seen_jobs.add(i["job_id"])
        add(f"incident-{i['id']}", "red", "cron", f"cron job failing: {names.get(i['job_id'], i['job_id'])}", short(i.get("error"), 160) or "",
            node=f"cron:{i['job_id']}")
    for j in jobs:
        if j["missed"] and j["id"] not in seen_jobs:
            add(f"missed-{j['id']}", "red", "cron", f"missed trigger: {j['name']}", f"{plural(j.get('missed_count') or 1, 'slot')} skipped", node=f"cron:{j['id']}")
        elif j["state"] == "error" and j["id"] not in seen_jobs:
            add(f"failed-{j['id']}", "amber", "cron", f"last run failed: {j['name']}", short(j.get("last_error"), 160) or "", node=f"cron:{j['id']}")
    cr = by.get("cron")
    if cr and cr["level"] == "red" and "scheduler silent" in cr["detail"]:
        add("scheduler", "red", "cron", cr["detail"], "no ticker heartbeat: jobs will not fire", tab="tasks")
    stuck = deliveries["pending"] + deliveries["delivering"] + deliveries["failed"]
    if stuck:
        add("deliveries", "amber", "cron", f"{plural(stuck, 'cron result')} not delivered", f"{deliveries['failed']} failed", tab="tasks")
    if kb.get("board") is not None:
        for a in kb["attention"]:
            add(f"kanban-{a['id']}", "red" if a["why"] == "worker silent" else "amber", "kanban",
                f"{a['title']}: {a['why']}", "", tab="board")
        if kb["counts"].get("blocked"):
            add("kanban-blocked", "amber", "kanban", f"{plural(kb['counts']['blocked'], 'kanban card')} blocked", "", tab="board")
    e = by.get("errors")
    if e and e["level"] != "green":
        add("errors", e["level"], "log", e["detail"], (e.get("recent") or [""])[-1], tab="logs")
    st = by.get("storage")
    if st and st["level"] != "green":
        add("storage", st["level"], "storage", st["detail"], "", tab="overview")
    if orphans:
        add("orphans", "amber", "session", f"{plural(orphans, 'session')} orphaned by a restart (24h)", "", tab="sessions")
    if waiting:
        add("waiting", "info", "session", f"{plural(waiting, 'session')} waiting for you", "Hermes replied and the next move is yours", tab="sessions")
    rank = {"red": 0, "amber": 1, "info": 2}
    items.sort(key=lambda x: rank.get(x["severity"], 3))
    return items


LEVEL_RANK = {"green": 0, "amber": 1, "red": 2}
worst_of = lambda *levels: max(levels, key=lambda l: LEVEL_RANK.get(l, 1))

# Hermes' vocabulary for the process (gateway/run_startup.py writes these) and for one transport
GATEWAY_LEVEL = {"running": "green", "starting": "amber", "degraded": "amber", "stopping": "amber",
                 "stopped": "red", "startup_failed": "red"}
PLATFORM_LEVEL = {"connected": "green", "retrying": "amber", "fatal": "red", "disconnected": "red", "stopped": "amber"}
GATEWAY_STALE_AFTER = 900          # the gateway rewrites the file on every platform change and on a timer


def load_gateway_state() -> Optional[dict]:
    """`gateway_state.json`: the gateway's own account of itself, written by hermes-agent on start,
    on every platform state change and on shutdown. Absent on older Hermes or when it never started."""
    try:
        d = json.loads((DATA / "gateway_state.json").read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(d, dict) or d.get("kind", "hermes-gateway") != "hermes-gateway":
        return None
    return d


def gateway_summary(gs: Optional[dict], now: float) -> Optional[dict]:
    """The state file reduced to what the picture needs: process state and version, and one row per
    platform with a traffic-light level, the error Hermes recorded and when the state last changed.
    `argv`, paths and anything else that could carry a secret never leave this function."""
    if not gs:
        return None
    state = str(gs.get("gateway_state") or "unknown")
    desired = gs.get("desired_state")
    updated = ts(gs.get("updated_at")) or ts(gs.get("timestamp"))
    age = (now - updated) if updated else None
    stale = state == "running" and age is not None and age > GATEWAY_STALE_AFTER
    platforms = []
    for name, p in sorted((gs.get("platforms") or {}).items()):
        if not isinstance(p, dict):
            continue
        pstate = str(p.get("state") or "unknown")
        level = PLATFORM_LEVEL.get(pstate, "amber")
        if p.get("needs_attention"):
            level = "red"
        err = redact(short(p.get("error_message"), 160) or "")
        when = ts(p.get("updated_at"))
        since = ts(p.get("retrying_since")) or (when if pstate == "retrying" else None)
        detail = pstate
        if pstate == "retrying":
            detail = "retrying" + (f" since {_rel(now - since)}" if since else "") + (f" · {err}" if err else "")
        elif level == "red":
            detail = f"{pstate}" + (f": {err}" if err else "")
        elif pstate == "connected":
            m = p.get("metrics") if isinstance(p.get("metrics"), dict) else None
            if m:
                today = m.get("metrics_today") if isinstance(m.get("metrics_today"), dict) else {}
                bits = [plural(m.get('active_runs', 0), 'active run')]
                if today.get("requests"):
                    bits.append(f"{plural(today['requests'], 'request')} today")
                detail = "connected · " + " · ".join(bits)
            elif when:
                detail = f"connected {_rel(now - when)}"
        platforms.append({"name": name, "state": pstate, "level": level, "detail": detail, "error_code": p.get("error_code"),
                          "error": err or None, "updated": when, "since": since, "needs_attention": bool(p.get("needs_attention")),
                          "listener": p.get("listener_base")})
    return {"state": state, "desired": desired, "level": GATEWAY_LEVEL.get(state, "amber"), "version": gs.get("code_version"),
            "sha": (gs.get("code_sha") or "")[:12] or None, "pid": gs.get("pid"),
            "started": None,       # start_time is Linux /proc ticks since boot (a pid fingerprint), not an epoch
            "updated": updated, "age": age, "stale": stale, "profiles": gs.get("served_profiles") or [],
            "restart_requested": bool(gs.get("restart_requested")), "exit_reason": gs.get("exit_reason"), "platforms": platforms}


def _rel(seconds: float) -> str:
    """'3m ago' / '2h ago' / '9d ago' for a non-negative age."""
    seconds = max(0, seconds)
    if seconds < 90:
        return f"{int(seconds)}s ago"
    if seconds < 5400:
        return f"{int(seconds // 60)}m ago"
    if seconds < 172800:
        return f"{int(seconds // 3600)}h ago"
    return f"{int(seconds // 86400)}d ago"


def storage_state() -> dict:
    """Sizes of the Hermes data files Keryx reads and the free space on the disk that holds them."""
    size = lambda p: p.stat().st_size if p.exists() else 0
    logs = 0
    try:
        logs = sum(size(p) for p in (DATA / "logs").glob("*.log*"))
    except OSError:
        pass
    free = total = None
    try:
        import shutil
        du = shutil.disk_usage(DATA)
        free, total = du.free, du.total
    except OSError:
        pass
    return {"db": size(DATA / "state.db"), "wal": size(DATA / "state.db-wal"), "logs": logs,
            "free": free, "total": total, "free_pct": round(100 * free / total, 1) if free is not None and total else None}


def fmt_bytes(n: Optional[int]) -> str:
    if n is None:
        return "?"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.1f} {unit}"
        n /= 1024
    return str(n)


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


CONTEXT_PARTS = {"user": "your messages", "assistant": "Hermes' replies", "calls": "tool call arguments",
                 "tools": "tool output", "summary": "compaction summaries"}


def build_context(sid: str) -> dict:
    """What fills a session's context (hermes-workspace's context-bloat analysis, per session): the live rows of
    the current segment split into your messages, Hermes' replies, tool-call arguments, tool output by tool,
    and compaction summaries, in characters. Tool output is usually most of it; this says which tools."""
    db = STATE.get()
    if db is None:
        return {"error": "no state db"}
    sessions = load_sessions(db)
    logical, alias = logical_sessions(sessions)
    ls = next((x for x in logical if x["id"] == alias.get(sid, sid)), None)
    segs = ls["segments"] if ls else [sid]
    tip = segs[-1]
    row = next((x for x in sessions if x["id"] == tip), None)
    mcols = table_columns(db, "messages")
    kind_col = ", display_kind" if "display_kind" in mcols else ", null as display_kind"
    rows = db.execute(f"select role, content, tool_calls, tool_name, timestamp{kind_col} from messages where session_id = ?"
                      f"{live_rows_sql(db)} order by timestamp asc, id asc", (tip,)).fetchall()
    parts = {k: {"kind": k, "label": v, "chars": 0, "count": 0} for k, v in CONTEXT_PARTS.items()}
    tools: dict[str, dict] = {}
    biggest: list[dict] = []
    titles: dict[str, str] = {}
    for r in rows:
        role, content = r["role"], r["content"] or ""
        if role == "user":
            k = "summary" if r["display_kind"] == "hidden" else "user"
            parts[k]["chars"] += len(content); parts[k]["count"] += 1
        elif role == "assistant":
            if content:
                parts["assistant"]["chars"] += len(content); parts["assistant"]["count"] += 1
            if r["tool_calls"]:
                parts["calls"]["chars"] += len(r["tool_calls"]); parts["calls"]["count"] += 1
                try:
                    for c in json.loads(r["tool_calls"]) or []:
                        fn = c.get("function", {}) if isinstance(c, dict) else {}
                        cid = c.get("call_id") or c.get("id")
                        if cid:
                            titles[cid] = step_title(fn.get("name") or "", parse_args(fn.get("arguments") or ""))
                except Exception:
                    pass
        elif role == "tool":
            name = r["tool_name"] or "tool"
            n = len(content)
            parts["tools"]["chars"] += n; parts["tools"]["count"] += 1
            t = tools.setdefault(name, {"name": name, "kind": tool_kind(name), "chars": 0, "calls": 0})
            t["chars"] += n; t["calls"] += 1
            biggest.append({"name": name, "chars": n, "ts": ts(r["timestamp"]), "title": titles.get(r["tool_call_id"] if "tool_call_id" in r.keys() else "", "")})
    total = sum(p["chars"] for p in parts.values())
    for p_ in parts.values():
        p_["share"] = round(p_["chars"] / total, 4) if total else 0.0
    tool_list = sorted(tools.values(), key=lambda t: -t["chars"])
    for t in tool_list:
        t["share"] = round(t["chars"] / total, 4) if total else 0.0
    biggest.sort(key=lambda b: -b["chars"])
    gauge = context_gauge(row) if row else None
    return {"session": alias.get(sid, sid), "segment": tip, "segments": segs, "rows": len(rows), "total_chars": total,
            "est_tokens": int(total / 4), "gauge": gauge, "parts": sorted(parts.values(), key=lambda p: -p["chars"]),
            "tools": tool_list[:12], "biggest": biggest[:5]}


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


# ----------------------------------------------------------------- kanban (Hermes' task queue)
# Lane order and glyphs are hermes_cli.kanban_workflow.DEFAULT_WORKFLOW; `archived` is appended on request.
KANBAN_LANES = [("triage", "Triage", "◇"), ("todo", "Todo", "◻"), ("scheduled", "Scheduled", "⏱"), ("ready", "Ready", "▶"),
                ("running", "Running", "●"), ("blocked", "Blocked", "⊘"), ("review", "Review", "◎"), ("done", "Done", "✓")]
KANBAN_ARCHIVED = "archived"
KANBAN_STALE_HEARTBEAT = 600            # a running worker heartbeats every tick; silence this long means it died
_KANBAN: dict[str, Snapshot] = {}       # one in-memory copy per board database


def kanban_boards() -> list[dict]:
    """Every board Hermes keeps: `default` at <data>/kanban.db (hermes_cli.kanban_db keeps it there for
    back-compat), the others at <data>/kanban/boards/<slug>/kanban.db with a board.json beside them.
    `<data>/kanban/current` names the board the CLI acts on; absent means default."""
    current = "default"
    try:
        current = (DATA / "kanban" / "current").read_text().strip() or "default"
    except OSError:
        pass
    boards: list[dict] = []

    def meta(slug: str) -> dict:
        try:
            d = json.loads((DATA / "kanban" / "boards" / slug / "board.json").read_text())
            return d if isinstance(d, dict) else {}
        except (OSError, ValueError):
            return {}

    if (DATA / "kanban.db").exists():
        m = meta("default")
        boards.append({"slug": "default", "name": m.get("name") or m.get("display_name") or "default", "path": str(DATA / "kanban.db"),
                       "archived": bool(m.get("archived"))})
    try:
        dirs = sorted(d for d in (DATA / "kanban" / "boards").iterdir() if d.is_dir() and d.name != "default")
    except OSError:
        dirs = []
    for d in dirs:
        if (d / "kanban.db").exists():
            m = meta(d.name)
            boards.append({"slug": d.name, "name": m.get("name") or m.get("display_name") or d.name, "path": str(d / "kanban.db"),
                           "archived": bool(m.get("archived"))})
    for b in boards:
        b["current"] = b["slug"] == current
    return boards


def kanban_db(board: Optional[str]):
    """Snapshot connection for a board (the current one when `board` is empty); None if there is no such board."""
    boards = kanban_boards()
    pick = next((b for b in boards if b["slug"] == board), None) if board else next((b for b in boards if b["current"]), None) or (boards[0] if boards else None)
    if not pick:
        return None, None
    snap = _KANBAN.get(pick["path"])
    if snap is None:
        snap = _KANBAN[pick["path"]] = Snapshot(Path(pick["path"]))
    return snap.get(), pick


def _kanban_task(r, cols: set[str], now: float, links_up: dict, links_down: dict, comments: dict, runs: dict) -> dict:
    g = lambda k: r[k] if k in cols else None
    status = g("status") or "triage"
    hb = ts(g("last_heartbeat_at"))
    started = ts(g("started_at"))
    max_rt = g("max_runtime_seconds")
    stale = status == "running" and ((hb is not None and now - hb > KANBAN_STALE_HEARTBEAT)
                                     or (hb is None and started is not None and now - started > KANBAN_STALE_HEARTBEAT)
                                     or (max_rt and started and now - started > max_rt))
    skills = g("skills")
    try:
        skills = json.loads(skills) if isinstance(skills, str) else skills
    except ValueError:
        skills = None
    last = runs.get(r["id"])
    return {
        "id": r["id"], "title": short(g("title"), 140) or r["id"], "body": short(g("body"), 400), "assignee": g("assignee"),
        "status": status, "priority": g("priority") or 0, "created_by": g("created_by"), "created_at": ts(g("created_at")),
        "started_at": started, "completed_at": ts(g("completed_at")), "workspace_kind": g("workspace_kind"),
        "workspace_path": g("workspace_path"), "branch": g("branch_name"), "project": g("project_id"), "session_id": g("session_id"),
        "result": short(g("result"), 400), "failures": g("consecutive_failures") or 0, "last_error": redact(short(g("last_failure_error"), 200) or "") or None,
        "heartbeat": hb, "worker_pid": g("worker_pid"), "run_id": g("current_run_id"), "block_kind": g("block_kind"),
        "skills": skills if isinstance(skills, list) else None, "model": g("model_override"), "step": g("current_step_key"),
        "parents": links_up.get(r["id"], []), "children": links_down.get(r["id"], []), "comments": comments.get(r["id"], 0),
        "runs": last["n"] if last else 0, "last_run": last["row"] if last else None, "stale": bool(stale),
        "age": now - (ts(g("created_at")) or now),
    }


def _kanban_run(r, cols: set[str]) -> dict:
    g = lambda k: r[k] if k in cols else None
    return {"id": r["id"], "profile": g("profile"), "step": g("step_key"), "status": g("status"), "outcome": g("outcome"),
            "summary": short(g("summary"), 300), "error": redact(short(g("error"), 200) or "") or None,
            "started_at": ts(g("started_at")), "ended_at": ts(g("ended_at")), "heartbeat": ts(g("last_heartbeat_at")),
            "worker_pid": g("worker_pid"), "duration": ((ts(g("ended_at")) or time.time()) - ts(g("started_at"))) if ts(g("started_at")) else None}


def build_kanban(board: Optional[str] = None, include_archived: bool = False) -> dict:
    """The board as lanes (hermes-desktop's Kanban tab, read-only): every task with its links, comment
    count and latest run, plus which running workers have gone quiet."""
    now = time.time()
    db, pick = kanban_db(board)
    boards = [{k: b[k] for k in ("slug", "name", "archived", "current")} for b in kanban_boards()]
    if db is None:
        return {"generated_at": now, "board": None, "boards": boards, "lanes": [], "counts": {}, "attention": [], "total": 0}
    try:
        cols = table_columns(db, "tasks")
        rows = db.execute("select * from tasks order by priority desc, created_at asc").fetchall()
        links = db.execute("select parent_id, child_id from task_links").fetchall() if "task_links" in _tables(db) else []
        comments = dict(db.execute("select task_id, count(*) from task_comments group by task_id").fetchall()) if "task_comments" in _tables(db) else {}
        run_rows = db.execute("select * from task_runs order by started_at desc, id desc limit 2000").fetchall() if "task_runs" in _tables(db) else []
    except sqlite3.OperationalError as e:
        return {"generated_at": now, "board": pick["slug"], "boards": boards, "lanes": [], "counts": {}, "attention": [], "total": 0, "error": str(e)}
    up: dict[str, list] = {}
    down: dict[str, list] = {}
    for parent, child in links:
        up.setdefault(child, []).append(parent)
        down.setdefault(parent, []).append(child)
    run_cols = table_columns(db, "task_runs") if run_rows else set()
    runs: dict[str, dict] = {}
    for rr in run_rows:
        cur = runs.setdefault(rr["task_id"], {"n": 0, "row": _kanban_run(rr, run_cols)})
        cur["n"] += 1
    tasks = [_kanban_task(r, cols, now, up, down, comments, runs) for r in rows]
    by_status: dict[str, list] = {}
    for t in tasks:
        by_status.setdefault(t["status"], []).append(t)
    lanes = [{"key": k, "label": label, "glyph": glyph, "tasks": by_status.pop(k, [])} for k, label, glyph in KANBAN_LANES]
    archived = by_status.pop(KANBAN_ARCHIVED, [])
    for k, extra in by_status.items():          # a custom workflow column Keryx does not know: still shown
        lanes.append({"key": k, "label": k, "glyph": "·", "tasks": extra})
    if include_archived:
        lanes.append({"key": KANBAN_ARCHIVED, "label": "Archived", "glyph": "▪", "tasks": archived})
    counts = {l["key"]: len(l["tasks"]) for l in lanes}
    counts["archived"] = len(archived)
    attention = ([{"id": t["id"], "title": t["title"], "why": "worker silent"} for t in tasks if t["stale"]]
                 + [{"id": t["id"], "title": t["title"], "why": f"{t['failures']} failures in a row"} for t in tasks
                    if t["failures"] >= 2 and t["status"] not in ("done", KANBAN_ARCHIVED)])
    return {"generated_at": now, "board": pick["slug"], "board_name": pick["name"], "boards": boards, "lanes": lanes, "counts": counts,
            "attention": attention, "total": len(tasks) - len(archived), "stale_after": KANBAN_STALE_HEARTBEAT}


def build_kanban_task(task_id: str, board: Optional[str] = None) -> dict:
    """One card in full: comments, the event timeline and the run history (hermes-desktop's detail drawer)."""
    now = time.time()
    db, pick = kanban_db(board)
    if db is None:
        return {"error": "no kanban board"}
    r = db.execute("select * from tasks where id = ?", (task_id,)).fetchone()
    if not r:
        return {"error": "task not found"}
    cols = table_columns(db, "tasks")
    tables = _tables(db)
    up = {task_id: [x[0] for x in db.execute("select parent_id from task_links where child_id = ?", (task_id,))]} if "task_links" in tables else {}
    down = {task_id: [x[0] for x in db.execute("select child_id from task_links where parent_id = ?", (task_id,))]} if "task_links" in tables else {}
    comments = []
    if "task_comments" in tables:
        comments = [{"id": c["id"], "author": c["author"], "body": short(c["body"], 600), "created_at": ts(c["created_at"])}
                    for c in db.execute("select * from task_comments where task_id = ? order by created_at asc, id asc limit 50", (task_id,))]
    runs = []
    if "task_runs" in tables:
        rc = table_columns(db, "task_runs")
        runs = [_kanban_run(x, rc) for x in db.execute("select * from task_runs where task_id = ? order by started_at desc, id desc limit 20", (task_id,))]
    events = []
    if "task_events" in tables:
        for e in db.execute("select * from task_events where task_id = ? order by created_at desc, id desc limit 60", (task_id,)):
            payload = e["payload"]
            try:
                payload = json.loads(payload) if isinstance(payload, str) else payload
            except ValueError:
                pass
            if isinstance(payload, dict):
                payload = {k: v for k, v in payload.items() if k in ("by", "actor", "author", "reason", "parent", "child", "priority", "filename", "fields", "outcome", "status", "from", "to")}
            text = ", ".join(f"{k} {v}" for k, v in payload.items()) if isinstance(payload, dict) else payload
            events.append({"id": e["id"], "kind": e["kind"], "run_id": e["run_id"], "created_at": ts(e["created_at"]),
                           "detail": redact(short(text if isinstance(text, str) else json.dumps(text), 200) or "") or None})
        events.reverse()
    attachments = 0
    if "task_attachments" in tables:
        attachments = db.execute("select count(*) from task_attachments where task_id = ?", (task_id,)).fetchone()[0]
    task = _kanban_task(r, cols, now, up, down, {task_id: len(comments)}, {task_id: {"n": len(runs), "row": runs[0]}} if runs else {})
    task["body"] = short(r["body"] if "body" in cols else None, 4000) or None
    task["result"] = short(r["result"] if "result" in cols else None, 4000) or None
    return {"generated_at": now, "board": pick["slug"], "task": task, "comments": comments, "runs": runs, "events": events, "attachments": attachments}


def _tables(db) -> set[str]:
    return {r[0] for r in db.execute("select name from sqlite_master where type = 'table'")}


def kanban_session_index() -> dict[str, dict]:
    """session id → the kanban task a worker session belongs to (tasks.session_id), across every board."""
    out: dict[str, dict] = {}
    for b in kanban_boards():
        db, pick = kanban_db(b["slug"])
        if db is None or "session_id" not in table_columns(db, "tasks"):
            continue
        try:
            for r in db.execute("select id, title, status, session_id from tasks where session_id is not null and session_id <> ''"):
                out[r["session_id"]] = {"id": r["id"], "title": short(r["title"], 80), "status": r["status"], "board": pick["slug"]}
        except sqlite3.OperationalError:
            pass
    return out


def kanban_overview() -> Optional[dict]:
    """Counts only, for tab badges and the diagnostics bundle; None when Hermes has no board."""
    k = build_kanban()
    if k["board"] is None:
        return None
    return {"board": k["board"], "boards": len(k["boards"]), "counts": k["counts"], "attention": len(k["attention"]), "total": k["total"]}


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
                summary = f"{plural(len(results), 'result')}"
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
            "scheduler": scheduler_state(now), "incidents": incidents[:50], "deliveries": load_deliveries(), "kanban": kanban_overview()}


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
                           "flags": {"pinned": sum(1 for s in sessions if s.get("pinned")), "hidden": sum(1 for s in sessions if s.get("hidden")),
                                     "archived": sum(1 for s in sessions if s.get("archived")),
                                     "internal": sum(1 for s in sessions if s.get("source") in INTERNAL_SOURCES)},
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
    out["attention"] = [{"severity": a["severity"], "source": a["source"], "label": redact(a["label"])} for a in status["attention"]]
    out["kanban"] = kanban_overview()
    gw = gateway_summary(load_gateway_state(), now)
    out["hermes"] = {k: gw[k] for k in ("state", "desired", "version", "sha", "age", "stale", "profiles", "restart_requested", "exit_reason")} | {
        "platforms": [{k: p[k] for k in ("name", "state", "level", "error_code", "needs_attention")} | {"error": redact(p["error"] or "")} for p in gw["platforms"]]} if gw else None
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


HEATMAP_WEEKS = 53


def build_heatmap(db, now: float) -> dict:
    """A year of days (53 ISO weeks ending this week, Monday-aligned, UTC) with sessions started, tool
    calls, tokens and cost per day: the calendar heatmap cc-switch's and GitHub's usage pages draw.
    Reads the sessions table directly (no MAX_SESSIONS cap) so a busy year is still complete."""
    today = datetime.fromtimestamp(now, timezone.utc).date()
    monday = today - _dt.timedelta(days=today.weekday())
    start_day = monday - _dt.timedelta(weeks=HEATMAP_WEEKS - 1)
    start = datetime(start_day.year, start_day.month, start_day.day, tzinfo=timezone.utc).timestamp()
    days: dict[str, dict] = {}
    d = start_day
    while d <= today + _dt.timedelta(days=6 - today.weekday()):
        days[d.isoformat()] = {"day": d.isoformat(), "sessions": 0, "tool_calls": 0, "tokens": 0, "cost_usd": 0.0}
        d += _dt.timedelta(days=1)
    cols = table_columns(db, "sessions")
    tcc = "coalesce(tool_call_count, 0)" if "tool_call_count" in cols else "0"
    rows = db.execute(f"select id, started_at, {tcc} as calls from sessions where started_at >= ?", (start,)).fetchall()
    day_of = {}
    for r in rows:
        t = ts(r["started_at"])
        if t is None:
            continue
        key = _day(t)
        b = days.get(key)
        if b is None:
            continue
        day_of[r["id"]] = key
        b["sessions"] += 1
        b["tool_calls"] += r["calls"] or 0
    if day_of:
        usage = session_usage(db, list(day_of))
        for sid, u in usage.items():
            b = days[day_of[sid]]
            b["tokens"] += u["tokens_in"] + u["tokens_out"] + u["cache_read"]
            b["cost_usd"] += u["cost_usd"] or 0
    for b in days.values():
        b["cost_usd"] = round(b["cost_usd"], 4)
    out = list(days.values())
    active = [b for b in out if b["sessions"]]
    return {"start": start_day.isoformat(), "weeks": HEATMAP_WEEKS, "days": out,
            "active_days": len(active), "streak": _streak(out, today.isoformat()),
            "max": {k: max((b[k] for b in out), default=0) for k in ("sessions", "tool_calls", "tokens", "cost_usd")}}


def _streak(days: list[dict], today: str) -> int:
    """Consecutive days with a session, counted back from today (yesterday if today is quiet so far)."""
    idx = {b["day"]: i for i, b in enumerate(days)}
    i = idx.get(today)
    if i is None:
        return 0
    if not days[i]["sessions"]:
        i -= 1
    n = 0
    while i >= 0 and days[i]["sessions"]:
        n += 1
        i -= 1
    return n


def load_skill_usage() -> list[dict]:
    """Hermes' skill ledger (skills/.usage.json, written by tools/skill_usage.py): per skill the use and view
    counts, last use, lifecycle state. Read-only; hermes-webui's Insights page shows the same file."""
    try:
        raw = json.loads((DATA / "skills" / ".usage.json").read_text())
    except Exception:
        return []
    out = []
    for name, v in (raw.items() if isinstance(raw, dict) else []):
        if not isinstance(v, dict):
            continue
        out.append({"name": name, "uses": int(v.get("use_count") or 0), "views": int(v.get("view_count") or 0),
                    "patches": int(v.get("patch_count") or 0), "state": v.get("state") or "active",
                    "pinned": bool(v.get("pinned")), "last_used": ts(v.get("last_used_at")),
                    "created": ts(v.get("created_at")), "archived": v.get("archived_at") is not None})
    out.sort(key=lambda x: (-(x["last_used"] or 0), -x["uses"], x["name"]))
    return out


def build_analytics(days: int) -> dict:
    db = STATE.get()
    now = time.time()
    start = now - days * 86400
    if db is None:
        return {"days": [], "models": [], "totals": {}}
    sessions = [s for s in load_sessions(db) if (s["started_at"] or 0) >= start]
    ids = [s["id"] for s in sessions]
    per_day: dict[str, dict] = {}
    empty = {"sessions": 0, "subagents": 0, "user_messages": 0, "tool_calls": 0, "tool_errors": 0,
             "tokens_in": 0, "tokens_out": 0, "cache_read": 0, "cost_usd": 0.0}
    for i in range(days):
        per_day[_day(start + i * 86400 + 1)] = dict(empty)
    per_day.setdefault(_day(now), dict(empty))
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
        kind_col = ", display_kind" if "display_kind" in table_columns(db, "messages") else ", null as display_kind"
        for r in db.execute(f"select session_id, role, content, timestamp{kind_col} from messages where session_id in ({q}) "
                            f"and role in ('user','tool') and timestamp >= ?{live_rows_sql(db)}{hidden_rows_sql(db)}", (*ids, start)):
            t = ts(r["timestamp"]) or 0
            b = per_day.setdefault(_day(t), dict.fromkeys(per_day[next(iter(per_day))].keys(), 0))
            if r["role"] == "user":
                if r["display_kind"] in EVENT_KINDS and r["display_kind"] != "steer":
                    continue                      # Hermes' injected event rows are not the human speaking
                b["user_messages"] += 1
            else:
                b["tool_calls"] += 1
                if tool_result_failed(r["content"]):
                    b["tool_errors"] += 1
        for sid, u in session_usage(db, ids).items():
            d = day_of_session.get(sid)
            if d and d in per_day:
                per_day[d]["tokens_in"] += u["tokens_in"]
                per_day[d]["tokens_out"] += u["tokens_out"]
                per_day[d]["cache_read"] += u["cache_read"]
                per_day[d]["cost_usd"] = round(per_day[d]["cost_usd"] + (u["cost_usd"] or 0), 4)
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
    skills = load_skill_usage()
    tot["skills"] = len(skills)
    tot["skills_used"] = sum(1 for k in skills if (k["last_used"] or 0) >= start)
    providers = provider_mix(db, ids)
    clock = clock_profile(db, ids, start)
    velocity = velocity_of(days_list, days)
    out = {"generated_at": now, "window_days": days, "days": days_list, "models": models, "totals": tot,
           "skills": skills[:40], "heatmap": build_heatmap(db, now), "providers": providers, "clock": clock, "velocity": velocity,
           "achievements": load_achievements()}
    out["insights"] = insights_of(out, skills, start)
    return out


def load_achievements() -> Optional[dict]:
    """Unlocks recorded by Hermes' achievements plugin (plugin-data/hermes-achievements/state.json). Names and
    descriptions live in the plugin's catalogue, not on disk, so the id is shown in words with its tier and date."""
    try:
        d = json.loads((DATA / "plugin-data" / "hermes-achievements" / "state.json").read_text())
    except (OSError, ValueError):
        return None
    unlocks = d.get("unlocks") if isinstance(d, dict) else None
    if not isinstance(unlocks, dict):
        return None
    items = []
    for key, v in unlocks.items():
        if not isinstance(v, dict):
            continue
        items.append({"id": key, "name": key.replace("_", " ").replace("-", " "), "tier": v.get("first_tier"), "unlocked_at": ts(v.get("unlocked_at"))})
    items.sort(key=lambda x: -(x["unlocked_at"] or 0))
    return {"unlocked": len(items), "recent": items[:12]}


# ------------------------------------------------- analytics cards (after hermes-workspace's dashboard)
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def provider_mix(db, ids: list[str]) -> list[dict]:
    """Tokens and cost per billing provider (session_model_usage.billing_provider): which provider family
    does the work. hermes-workspace guesses this from model-name prefixes; Hermes records it."""
    if not ids:
        return []
    q = ",".join("?" * len(ids))
    cols = table_columns(db, "session_model_usage")
    act = "sum(coalesce(actual_cost_usd,0))" if "actual_cost_usd" in cols else "0"
    try:
        rows = db.execute(f"select coalesce(nullif(billing_provider,''),'unknown') p, sum(input_tokens) i, sum(output_tokens) o, "
                          f"sum(cache_read_tokens) c, sum(api_call_count) n, sum(coalesce(estimated_cost_usd,0)) est, {act} act, "
                          f"count(distinct session_id) s, count(distinct model) m from session_model_usage where session_id in ({q}) group by 1",
                          ids).fetchall()
    except sqlite3.OperationalError:
        return []
    out = [{"provider": r["p"], "tokens": (r["i"] or 0) + (r["o"] or 0), "input": r["i"] or 0, "output": r["o"] or 0,
            "cache_read": r["c"] or 0, "calls": r["n"] or 0, "sessions": r["s"], "models": r["m"],
            "cost_usd": round((r["act"] or 0) or (r["est"] or 0), 4)} for r in rows]
    total = sum(x["tokens"] for x in out) or 1
    for x in out:
        x["share"] = round(x["tokens"] / total, 4)
    return sorted(out, key=lambda x: -x["tokens"])


def clock_profile(db, ids: list[str], start: float) -> dict:
    """When Hermes works: sessions started per hour of day (1×24) and tool calls per weekday×hour (7×24), UTC.
    hermes-workspace rebuilds the hour strip from session start times; the grid comes from the tool rows."""
    hours = [{"hour": h, "sessions": 0, "tool_calls": 0} for h in range(24)]
    grid = [[0] * 24 for _ in range(7)]
    if ids:
        q = ",".join("?" * len(ids))
        for r in db.execute(f"select started_at from sessions where id in ({q})", ids):
            t = ts(r["started_at"])
            if t:
                hours[datetime.fromtimestamp(t, timezone.utc).hour]["sessions"] += 1
        for r in db.execute(f"select timestamp from messages where session_id in ({q}) and role = 'tool' and timestamp >= ?{live_rows_sql(db)}",
                            (*ids, start)):
            t = ts(r["timestamp"])
            if t:
                d = datetime.fromtimestamp(t, timezone.utc)
                hours[d.hour]["tool_calls"] += 1
                grid[d.weekday()][d.hour] += 1
    peak = max(hours, key=lambda h: h["tool_calls"] + h["sessions"])
    return {"hours": hours, "grid": grid, "weekdays": WEEKDAYS, "tz": "UTC",
            "peak_hour": peak["hour"] if (peak["tool_calls"] + peak["sessions"]) else None, "max": max(max(row) for row in grid)}


def velocity_of(days_list: list[dict], days: int) -> dict:
    """Sessions per day, and how the second half of the window compares with the first (momentum)."""
    if not days_list:
        return {"per_day": 0.0, "prior_per_day": 0.0, "delta_pct": None, "spark": []}
    rows = days_list[-days:] if days else days_list
    half = len(rows) // 2
    prior = sum(r["sessions"] for r in rows[:half]) / max(1, half)
    recent = sum(r["sessions"] for r in rows[half:]) / max(1, len(rows) - half)
    delta = round(100 * (recent - prior) / prior) if prior and half else None
    return {"per_day": round(sum(r["sessions"] for r in rows) / max(1, len(rows)), 2), "prior_per_day": round(prior, 2),
            "recent_per_day": round(recent, 2), "delta_pct": delta, "spark": [r["sessions"] for r in rows]}


def insights_of(a: dict, skills: list[dict], start: float) -> list[dict]:
    """Up to three plain sentences the numbers support (hermes-workspace's insight callouts): the peak day
    and the model behind it, cache reads against the first half of the window, the top skill."""
    out: list[dict] = []
    days_list = a["days"]
    busy = [d for d in days_list if d["tokens_in"] + d["tokens_out"] > 0]
    if busy and len(days_list) >= 3:
        peak = max(busy, key=lambda d: d["tokens_in"] + d["tokens_out"])
        driver = a["models"][0]["model"] if a["models"] else None
        out.append({"tone": "info", "text": f"Usage peaked on {peak['day']} ({_tok(peak['tokens_in'] + peak['tokens_out'])} tokens)"
                    + (f", mostly {driver}." if driver else ".")})
    if len(days_list) >= 14:
        half = len(days_list) // 2
        prior = sum(d["cache_read"] for d in days_list[:half])
        recent = sum(d["cache_read"] for d in days_list[half:])
        if prior > 0:
            delta = 100 * (recent - prior) / prior
            if abs(delta) >= 5:
                out.append({"tone": "positive" if delta > 0 else "warn",
                            "text": f"Cache reads {'up' if delta > 0 else 'down'} {abs(delta):.0f}% against the first half of the window."})
    v = a.get("velocity") or {}
    if v.get("delta_pct") is not None and abs(v["delta_pct"]) >= 25:
        out.append({"tone": "info", "text": f"Sessions per day {'up' if v['delta_pct'] > 0 else 'down'} {abs(v['delta_pct'])}% in the second half of the window "
                                            f"({v['recent_per_day']} vs {v['prior_per_day']})."})
    used = [k for k in skills if (k["last_used"] or 0) >= start and k["uses"]]
    if used:
        top = max(used, key=lambda k: k["uses"])
        share = 100 * top["uses"] / max(1, sum(k["uses"] for k in used))
        out.append({"tone": "info", "text": f"Top skill: {top['name']} ({top['uses']} uses, {share:.0f}% of skill activity)."})
    return out[:3]


def _tok(n: float) -> str:
    return f"{n / 1e6:.1f}M" if n >= 1e6 else f"{n / 1e3:.0f}k" if n >= 1e3 else str(int(n))


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


def _exit_code(content: Any) -> Optional[int]:
    try:
        d = json.loads(content) if isinstance(content, str) else content
        ec = d.get("exit_code") if isinstance(d, dict) else None
        return ec if isinstance(ec, int) else None
    except Exception:
        return None


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
    mcols = table_columns(db, "messages")
    has_kind = "display_kind" in mcols
    kind_col = ", display_kind" if has_kind else ", null as display_kind"
    # the model's reasoning, when the provider returned it: Hermes stores it beside the assistant row
    # (`reasoning` for most providers, `reasoning_content` for DeepSeek-style ones)
    think_cols = [c for c in ("reasoning", "reasoning_content") if c in mcols]
    think_col = "".join(f", {c}" for c in think_cols)
    q = ",".join("?" * len(segs))
    rows = db.execute(f"select session_id, role, content, tool_name, tool_call_id, tool_calls, timestamp, finish_reason, token_count{kind_col}{think_col} "
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
            thought = next((r[c] for c in think_cols if r[c]), None)
            if isinstance(thought, str) and thought.strip():
                steps.append({"kind": "thinking", "ts": t, "text": short(thought.strip(), THINKING_CHARS),
                              "chars": len(thought), "truncated": len(thought) > THINKING_CHARS})
            calls = []
            try:
                calls = json.loads(r["tool_calls"]) if r["tool_calls"] else []
            except Exception:
                calls = []
            for c in calls:
                fn = c.get("function", {}) if isinstance(c, dict) else {}
                name = fn.get("name") or c.get("name") or "?"
                raw_args = fn.get("arguments") or c.get("arguments") or ""
                args = parse_args(raw_args)
                step = {"kind": "tool_call", "ts": t, "name": name, "tool_kind": tool_kind(name),
                        "title": step_title(name, args), "diff": diff_summary(name, args),
                        "args": short(raw_args if isinstance(raw_args, str) else json.dumps(raw_args), 600),
                        "id": c.get("call_id") or c.get("id"), "result": None, "failed": None, "duration": None}
                steps.append(step)
                if step["id"]:
                    pending[step["id"]] = step
            if r["content"]:
                steps.append({"kind": "assistant", "ts": t, "text": short(r["content"], 800), "finish": r["finish_reason"]})
        elif role == "tool":
            step = pending.pop(r["tool_call_id"], None) if r["tool_call_id"] else None
            failed = tool_result_failed(r["content"])
            full = _result_text(r["content"])
            res = short(full, 700)
            meta = {"exit_code": _exit_code(r["content"]), "lines": len(full.splitlines()), "truncated": len(full) > 700}
            if step:
                step.update(result=res, failed=failed, duration=max(0.0, t - step["ts"]), result_ts=t,
                            name=step["name"] or r["tool_name"], **meta)
            else:
                name = r["tool_name"] or "tool"
                steps.append({"kind": "tool_call", "ts": t, "name": name, "tool_kind": tool_kind(name), "title": "",
                              "diff": None, "args": "", "result": res, "failed": failed, "duration": None, **meta})
    if tool:
        steps = [st for st in steps if st["kind"] == "tool_call" and st["name"] == tool]
    total = len(steps)
    thinking = sum(1 for st in steps if st["kind"] == "thinking")
    usage = load_usage(db, segs)
    return {"session": {"id": s["id"], "title": s.get("title"), "source": s.get("source"),
                        "model": s.get("model"), "started": s["started_at"], "ended": s["ended_at"],
                        "end_reason": s.get("end_reason"), "messages": s.get("message_count"),
                        "segments": segs, "compactions": s["compactions"], "tip": s["tip_id"],
                        "cwd": s.get("cwd"), "git_branch": s.get("git_branch")},
            "usage": list(usage.values()), "steps": steps[-limit:], "total": total, "truncated": total > limit, "thinking": thinking}


THINKING_CHARS = 1500          # a reasoning trace can run to tens of KB; the reader shows the head


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


# ----------------------------------------------------------------- memory
def memory_config() -> dict:
    """The `memory:` section of Hermes' config.yaml (limits and on/off switches), read with a small
    line scanner so Keryx needs no YAML dependency: the section is flat `key: value` pairs."""
    out = dict(MEMORY_DEFAULTS)
    for key, val in config_section("memory", {"memory_char_limit", "user_char_limit", "memory_enabled", "user_profile_enabled"}).items():
        if key in ("memory_char_limit", "user_char_limit"):
            try:
                out[key] = int(val)
            except ValueError:
                pass
        else:
            out[key] = val.lower() in ("1", "true", "yes", "on")
    return out


def build_memory() -> dict:
    """Hermes' two memory files as entry lists with their character budgets (hermes-webui's Memory
    panel and cc-switch's Hermes page show the same files, editable; Keryx only reads)."""
    out: dict[str, Any] = {"generated_at": time.time(), "enabled": SHOW_MEMORY, "files": []}
    if not SHOW_MEMORY:
        out["hint"] = "set KERYX_SHOW_MEMORY=1 to show Hermes' MEMORY.md and USER.md here"
        return out
    cfg = memory_config()
    for target, name in MEMORY_FILES.items():
        path = DATA / "memories" / name
        f: dict[str, Any] = {"target": target, "file": name, "path": str(path), "entries": [], "chars": 0,
                             "limit": cfg["memory_char_limit" if target == "memory" else "user_char_limit"],
                             "hermes_enabled": cfg["memory_enabled" if target == "memory" else "user_profile_enabled"],
                             "exists": path.exists(), "mtime": None}
        if path.exists():
            try:
                raw = path.read_text(errors="replace")
                f["mtime"] = path.stat().st_mtime
                entries = [e.strip() for e in raw.split(MEMORY_DELIMITER) if e.strip()]
                f["entries"] = [{"text": e, "blocked": e.startswith("[BLOCKED:")} for e in entries]
                f["chars"] = sum(len(e) for e in entries)
            except OSError as e:
                f["error"] = str(e)
        f["pct"] = round(100 * f["chars"] / f["limit"], 1) if f["limit"] else 0
        out["files"].append(f)
    return out


# ----------------------------------------------------------------- full-text search
FTS_TOKEN_RE = re.compile(r"[^\s\"]+")


def fts_query(q: str) -> str:
    """Quote every token so FTS5 syntax characters in user input (`-`, `*`, `:`, parentheses) are
    matched literally; FTS5's implicit AND joins the tokens. Mirrors hermes_state_search's sanitiser."""
    toks = [t.replace('"', '""') for t in FTS_TOKEN_RE.findall(q or "")]
    return " ".join(f'"{t}"' for t in toks)


def has_fts(db) -> bool:
    try:
        return bool(db.execute("select 1 from sqlite_master where type = 'table' and name = 'messages_fts'").fetchone())
    except sqlite3.OperationalError:
        return False


def build_search(q: str, limit: int) -> dict:
    """Sessions whose conversation mentions `q` (hermes-webui searches message content; Keryx's search box
    only knew titles and digests). Uses Hermes' own FTS5 index (messages_fts, maintained by its triggers)
    when the database has it, a LIKE scan otherwise; rows of a compression lineage fold into one hit.
    Returns snippets, so the match shows why a session came up."""
    db = STATE.get()
    q = (q or "").strip()
    if db is None or len(q) < 2:
        return {"q": q, "sessions": [], "rows": 0, "engine": None}
    logical, alias = logical_sessions(load_sessions(db))
    meta = {ls["id"]: ls for ls in logical}
    live, hidden = live_rows_sql(db, "m"), hidden_rows_sql(db).replace(" display_", " m.display_").replace("(display_", "(m.display_")
    rows: list = []
    engine = "fts5" if has_fts(db) else "like"
    if engine == "fts5":
        try:
            rows = db.execute(
                f"select m.session_id, m.role, m.timestamp, snippet(messages_fts, 0, '[', ']', '…', 14) as snip "
                f"from messages_fts join messages m on m.id = messages_fts.rowid "
                f"where messages_fts match ? and m.role in ('user', 'assistant'){live}{hidden} "
                f"order by rank limit 400", (fts_query(q),)).fetchall()
        except sqlite3.OperationalError:
            engine = "like"
    if engine == "like":
        rows = db.execute(
            f"select m.session_id, m.role, m.timestamp, substr(m.content, max(1, instr(lower(m.content), lower(?)) - 60), 160) as snip "
            f"from messages m where m.role in ('user', 'assistant') and m.content like ? escape '\\'{live}{hidden} "
            f"order by m.timestamp desc limit 400", (q, "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")).fetchall()
    hits: dict[str, dict] = {}
    for r in rows:
        sid = alias.get(r["session_id"], r["session_id"])
        ls = meta.get(sid)
        if ls is None:
            continue
        h = hits.setdefault(sid, {"id": sid, "title": ls.get("title"), "source": ls.get("source"), "hits": 0,
                                  "last": ls.get("last_activity_at"), "ended": ls.get("ended_at") is not None,
                                  "snippets": []})
        h["hits"] += 1
        if len(h["snippets"]) < 3:
            h["snippets"].append({"role": r["role"], "ts": ts(r["timestamp"]), "text": short(r["snip"], 200)})
    out = sorted(hits.values(), key=lambda h: (-(h["last"] or 0)))[:limit]
    return {"q": q, "sessions": out, "rows": len(rows), "engine": engine}


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
    out = {"ok": True, "time": time.time(), "state_db": (DATA / "state.db").exists(), "version": app.version}
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


@app.get("/api/session/{sid}/context")
def api_context(sid: str):
    """What fills the session's context window, by part and by tool (characters)."""
    return cached("context", build_context, sid)


@app.get("/api/memory")
def api_memory():
    return cached("memory", build_memory)


@app.get("/api/search")
def api_search(q: str = Query("", max_length=200), limit: int = Query(30, ge=1, le=100)):
    return cached("search", build_search, q, limit)


@app.get("/api/tasks")
def api_tasks():
    return cached("tasks", build_tasks)


@app.get("/api/kanban")
def api_kanban(board: Optional[str] = None, archived: bool = False):
    """Hermes' kanban board as lanes; `board` picks a board slug (default: the current one)."""
    return cached("kanban", build_kanban, board or None, archived)


@app.get("/api/kanban/{task_id}")
def api_kanban_task(task_id: str, board: Optional[str] = None):
    return cached("kanban-task", build_kanban_task, task_id, board or None)


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
