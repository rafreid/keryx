"""Keryx — Hermes activity graph, FastAPI backend.

Reads Hermes state (sqlite WAL) through snapshot copies keyed on file mtime, plus the
cron store and gateway logs, and exposes:
  GET /api/graph?hours=24[&at=<epoch>]   nodes/links (at = replay the graph as of that moment)
  GET /api/now                            running sessions with request + latest step
  GET /api/status                         health header (gateway, telegram, cron, errors, orphans)
  GET /api/cost?hours=24                  token/cost totals per model for the window
  GET /api/stream?hours=24                SSE: pushes {graph, now, status, cost} when data changes
  GET /api/health                         liveness
  /                                       the React app (static/)
"""
from __future__ import annotations

import asyncio
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

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

DATA = Path(os.environ.get("HERMES_DATA", "/opt/data"))
STATIC = Path(__file__).parent / "static"
ACTIVE_WINDOW = int(os.environ.get("ACTIVE_WINDOW", "300"))      # s: "touched recently"
STALE_AFTER = int(os.environ.get("STALE_AFTER", "1800"))         # s: running-but-idle → stale
MAX_SESSIONS = 600
TELEGRAM_USER = os.environ.get("TELEGRAM_USER", "")

app = FastAPI(title="Keryx", version="2.0")


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


def data_signature() -> tuple:
    return file_sig(DATA / "state.db", DATA / "state.db-wal", DATA / "cron" / "jobs.json",
                    DATA / "cron" / "executions.db", DATA / "logs" / "errors.log")


# ----------------------------------------------------------------- loaders
def load_sessions(db) -> list[dict]:
    cols = {r[1] for r in db.execute("pragma table_info(sessions)")}
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
        out.append(s)
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


def load_messages(db, session_ids: list[str], upto: Optional[float]) -> dict[str, dict]:
    """Per-session digest: first user message, last assistant step, tool stats (+errors), timestamps."""
    if not session_ids:
        return {}
    q = ",".join("?" * len(session_ids))
    params: list[Any] = list(session_ids)
    where_t = ""
    if upto is not None:
        where_t = " and timestamp <= ?"
        params.append(upto)
    rows = db.execute(
        f"select session_id, role, content, tool_name, tool_calls, timestamp, finish_reason from messages "
        f"where session_id in ({q}){where_t} order by timestamp asc, id asc", params
    ).fetchall()
    out: dict[str, dict] = {}
    for r in rows:
        sid = r["session_id"]
        d = out.setdefault(sid, {"request": None, "last_step": None, "last_ts": None, "last_assistant_ts": None,
                                 "tools": {}, "user_messages": 0, "tool_calls": 0, "tool_errors": 0,
                                 "recent_calls": [], "finish": None})
        t = ts(r["timestamp"]) or 0
        d["last_ts"] = max(d["last_ts"] or 0, t)
        role = r["role"]
        if role == "user":
            d["user_messages"] += 1
            if d["request"] is None and r["content"]:
                d["request"] = short(r["content"], 160)
        elif role == "assistant":
            names = tool_call_names(r["tool_calls"])
            d["finish"] = r["finish_reason"]
            d["last_assistant_ts"] = t
            if names:
                d["last_step"] = "calling " + ", ".join(names[:3])
            elif r["content"]:
                d["last_step"] = short(r["content"], 140)
        elif role == "tool":
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
    try:
        rows = db.execute(
            f"select model, coalesce(billing_provider,'') as provider, sum(input_tokens) i, sum(output_tokens) o, "
            f"sum(cache_read_tokens) c, sum(api_call_count) n, sum(coalesce(estimated_cost_usd,0)) cost, "
            f"count(distinct session_id) sessions from session_model_usage where session_id in ({q}) group by 1,2",
            session_ids,
        ).fetchall()
    except sqlite3.OperationalError:
        return {}
    out = {}
    for r in rows:
        key = r["model"] or "unknown-model"
        cur = out.setdefault(key, {"model": key, "providers": set(), "input": 0, "output": 0, "cache_read": 0,
                                   "calls": 0, "cost_usd": 0.0, "sessions": 0})
        if r["provider"]:
            cur["providers"].add(r["provider"])
        cur["input"] += r["i"] or 0
        cur["output"] += r["o"] or 0
        cur["cache_read"] += r["c"] or 0
        cur["calls"] += r["n"] or 0
        cur["cost_usd"] += r["cost"] or 0
        cur["sessions"] += r["sessions"] or 0
    for v in out.values():
        v["providers"] = sorted(v["providers"])
        denom = v["input"] + v["cache_read"]
        v["cache_hit"] = round(v["cache_read"] / denom, 3) if denom else 0.0
    return out


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
            for r in db.execute("select job_id, status, started_at, finished_at, error from executions "
                                "order by rowid desc limit 500"):
                e = dict(r)
                e["started_at"], e["finished_at"] = ts(e["started_at"]), ts(e["finished_at"])
                execs.append(e)
        except sqlite3.OperationalError:
            pass
    return jobs, execs


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
        idle = now - (s["last_activity_at"] or s["started_at"] or 0)
        return "running" if idle <= STALE_AFTER else "stale"
    reason = s.get("end_reason") or ""
    if reason == "startup_orphan_reap":
        return "orphaned"
    if digest.get("tool_errors", 0) and digest.get("finish") == "tool_calls":
        return "failed"
    if reason in ("cli_close", "tui_shutdown"):
        return "ended_by_user"
    return "ended"


# ----------------------------------------------------------------- builders
def build_graph(hours: float, at: Optional[float]) -> dict:
    db = STATE.get()
    if db is None:
        return {"error": "state.db not found", "nodes": [], "links": [], "stats": {}}
    now = time.time()
    end = at if at else now
    start = 0 if hours <= 0 else end - hours * 3600

    sessions = load_sessions(db)
    sel = []
    for s in sessions:
        st = s["started_at"] or 0
        if st > end:
            continue
        last = s["last_activity_at"] or st
        if at is not None:                      # replay: only what existed by then
            if last < start and (s["ended_at"] or 0) < start:
                continue
        elif last < start:
            continue
        sel.append(s)
    ids = [s["id"] for s in sel]
    id_set = set(ids)
    digests = load_messages(db, ids, upto=at)
    usage = load_usage(db, ids)
    delegations = [d for d in load_delegations(db) if d["origin_session"] in id_set]
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
                 calls=u["calls"], cost_usd=round(u["cost_usd"], 4), providers=u["providers"])

    counts = {"running": 0, "stale": 0, "active": 0, "orphaned": 0, "failed": 0, "errors": 0, "tool_calls": 0,
              "subagents": 0}
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
        is_sub = bool(s.get("parent_session_id")) or str(s["title"]).lower().startswith("subagent")
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
            request=d.get("request"), last_step=d.get("last_step"),
            messages=s.get("message_count") or 0, user_messages=d.get("user_messages", 0),
            tool_calls=d.get("tool_calls", 0), tool_errors=d.get("tool_errors", 0),
            calls_per_min=len(recent), children=children.get(sid, 0), end_reason=s.get("end_reason"),
            parent=s.get("parent_session_id") if s.get("parent_session_id") in id_set else None,
            val=3 + math.log1p(s.get("message_count") or 0),
        )
        parent = s.get("parent_session_id")
        if parent and parent in id_set:
            deleg = next((x for x in delegations if x["origin_session"] == parent and x["dispatched_at"]
                          and abs(x["dispatched_at"] - (s["started_at"] or 0)) < 120), None)
            add_link(f"session:{parent}", f"session:{sid}", kind="spawn", active=active, age=age,
                     state=(deleg or {}).get("state"), delivery=(deleg or {}).get("delivery_state"),
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

    return {
        "generated_at": now, "as_of": end, "window_hours": hours, "replay": at is not None,
        "stats": {"sessions": len(sel), **counts, "cron_jobs": len(jobs),
                  "cron_runs": sum(1 for e in execs if (e["finished_at"] or e["started_at"] or 0) >= start)},
        "nodes": nodes, "links": links,
    }


def build_now() -> dict:
    db = STATE.get()
    if db is None:
        return {"running": [], "generated_at": time.time()}
    now = time.time()
    sessions = [s for s in load_sessions(db) if s["ended_at"] is None]
    ids = [s["id"] for s in sessions]
    digests = load_messages(db, ids, upto=None)
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
        recent = [t for t in d.get("recent_calls", []) if now - t <= 60]
        running.append({
            "id": s["id"], "title": short(s["title"], 80), "source": s.get("source"), "model": s.get("model"),
            "status": status, "started": s["started_at"], "last": last, "elapsed": now - (s["started_at"] or now),
            "idle": now - last, "request": d.get("request"), "last_step": d.get("last_step"),
            "tool_calls": d.get("tool_calls", 0), "tool_errors": d.get("tool_errors", 0),
            "calls_per_min": len(recent), "children": len(children.get(s["id"], [])),
            "is_subagent": bool(s.get("parent_session_id")) or str(s["title"]).lower().startswith("subagent"),
            "parent": s.get("parent_session_id"),
        })
    running.sort(key=lambda r: (r["status"] != "running", -(r["last"] or 0)))
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

    # cron
    jobs, execs = load_cron()
    if not jobs:
        check("cron", "amber", "no jobs defined")
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
          recent=[short(l, 160) for l in err_lines[-3:]])

    # orphaned / failed sessions in last 24h
    orphans = stale = running = 0
    if db is not None:
        for s in load_sessions(db):
            last = s["last_activity_at"] or s["started_at"] or 0
            if now - last > 86400:
                continue
            if s.get("end_reason") == "startup_orphan_reap":
                orphans += 1
            if s["ended_at"] is None:
                if now - last <= STALE_AFTER:
                    running += 1
                else:
                    stale += 1
    check("sessions", "amber" if orphans else "green",
          f"{running} running, {stale} stale, {orphans} orphaned by restarts (24h)")

    worst = "red" if any(c["level"] == "red" for c in checks) else "amber" if any(c["level"] == "amber" for c in checks) else "green"
    return {"generated_at": now, "level": worst, "checks": checks}


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
           "cost_usd": round(sum(u["cost_usd"] for u in models), 4)}
    denom = tot["input"] + tot["cache_read"]
    tot["cache_hit"] = round(tot["cache_read"] / denom, 3) if denom else 0.0
    return {"generated_at": now, "window_hours": hours, "models": models, "totals": tot}


# ----------------------------------------------------------------- cache + routes
_cache: dict[tuple, tuple] = {}
_cache_lock = threading.Lock()


def cached(kind: str, builder, *args):
    key = (kind, *args, data_signature())
    with _cache_lock:
        hit = _cache.get(key)
        if hit:
            return hit
    val = builder(*args)
    with _cache_lock:
        if len(_cache) > 64:
            _cache.clear()
        _cache[key] = val
    return val


@app.get("/api/health")
def api_health():
    return {"ok": True, "time": time.time(), "data": str(DATA), "state_db": (DATA / "state.db").exists()}


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


def bundle(hours: float) -> dict:
    return {"graph": cached("graph", build_graph, hours, None), "now": cached("now", build_now),
            "status": cached("status", build_status), "cost": cached("cost", build_cost, hours)}


@app.get("/api/stream")
async def api_stream(hours: float = Query(24, ge=0)):
    """Server-sent events: one 'update' per data change, keepalive every 25 s."""
    async def gen():
        last_sig = None
        last_sent = 0.0
        while True:
            sig = data_signature()
            now = time.time()
            if sig != last_sig or now - last_sent > 60:
                payload = await asyncio.to_thread(bundle, hours)
                yield f"event: update\ndata: {json.dumps(payload)}\n\n"
                last_sig, last_sent = sig, now
            elif now - last_sent > 25:
                yield ": keepalive\n\n"
            await asyncio.sleep(2)
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
