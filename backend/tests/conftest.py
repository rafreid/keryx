"""A miniature Hermes data directory for the tests.

Builds `state.db`, the cron store and a couple of log files the way current hermes-agent writes
them (column names and flags copied from hermes_state_common.SCHEMA_SQL and cron/executions.py),
then points the Keryx app at it. Times are relative to NOW so status rules behave the same on any day.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app as keryx  # noqa: E402

NOW = time.time()
H = 3600

SESSIONS_DDL = """
create table sessions (
    id text primary key, source text not null, user_id text, chat_id text, display_name text,
    model text, model_config text, parent_session_id text, started_at real not null, ended_at real,
    end_reason text, message_count integer default 0, tool_call_count integer default 0,
    input_tokens integer default 0, output_tokens integer default 0, cache_read_tokens integer default 0,
    cache_write_tokens integer default 0, reasoning_tokens integer default 0, cwd text, git_branch text,
    billing_provider text, estimated_cost_usd real, actual_cost_usd real, cost_status text, title text,
    last_activity_at real, last_activity_description text, api_call_count integer default 0,
    profile_name text, archived integer not null default 0
)"""
MESSAGES_DDL = """
create table messages (
    id integer primary key autoincrement, session_id text not null, role text not null, content text,
    tool_call_id text, tool_calls text, tool_name text, timestamp real not null, token_count integer,
    finish_reason text, active integer not null default 1, compacted integer not null default 0,
    display_kind text, display_metadata text, message_uid text
)"""
USAGE_DDL = """
create table session_model_usage (
    session_id text not null, model text not null, billing_provider text not null default '',
    billing_base_url text not null default '', billing_mode text not null default '', task text not null default '',
    api_call_count integer not null default 0, input_tokens integer not null default 0,
    output_tokens integer not null default 0, cache_read_tokens integer not null default 0,
    cache_write_tokens integer not null default 0, reasoning_tokens integer not null default 0,
    estimated_cost_usd real not null default 0, actual_cost_usd real not null default 0,
    cost_status text, cost_source text, first_seen real, last_seen real
)"""
HEARTBEATS_DDL = """
create table gateway_heartbeats (backend_id text primary key, pid integer not null, started_at real not null,
    last_heartbeat real not null, profile text not null default '', host text not null default '')"""
DELEGATIONS_DDL = """
create table async_delegations (
    delegation_id text primary key, origin_session text not null, parent_session_id text, state text not null,
    dispatched_at real not null, completed_at real, updated_at real not null, event_json text, result_json text,
    delivery_state text not null default 'pending', delivery_attempts integer not null default 0, task_json text
)"""
EXECUTIONS_DDL = """
create table executions (
    id text primary key, job_id text not null, source text not null, process_id text not null, pid integer not null,
    status text not null, claimed_at text not null, started_at text, finished_at text, error text,
    delivery_outcome text, scheduled_instant text, progress_at text
)"""


def tool_result(output="ok", exit_code=0, error=None):
    return json.dumps({"output": output, "exit_code": exit_code, "error": error})


def call(name, args, cid):
    return json.dumps([{"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}])


def write_state_db(path: Path) -> None:
    db = sqlite3.connect(path)
    for ddl in (SESSIONS_DDL, MESSAGES_DDL, USAGE_DDL, HEARTBEATS_DDL, DELEGATIONS_DDL):
        db.execute(ddl)

    def session(sid, source, started, ended=None, reason=None, parent=None, model="gpt-5", cfg=None, **kw):
        cols = dict(id=sid, source=source, started_at=started, ended_at=ended, end_reason=reason,
                    parent_session_id=parent, model=model, model_config=json.dumps(cfg) if cfg else None,
                    title=kw.pop("title", f"title of {sid}"), last_activity_at=kw.pop("last", ended or NOW - 60),
                    message_count=kw.pop("message_count", 4), **kw)
        db.execute(f"insert into sessions ({','.join(cols)}) values ({','.join('?' * len(cols))})", list(cols.values()))

    def msg(sid, role, content=None, t=None, **kw):
        cols = dict(session_id=sid, role=role, content=content, timestamp=t if t is not None else NOW - 60, **kw)
        db.execute(f"insert into messages ({','.join(cols)}) values ({','.join('?' * len(cols))})", list(cols.values()))

    # s-running: open, mid-turn (last row is a tool result), 2 live tool calls (1 failed) + archived copies
    session("s-running", "telegram", NOW - 2 * H, last=NOW - 30,
            cfg={"_usage_anchor": {"prompt_tokens": 120000}}, cwd="/work/repo", git_branch="main",
            last_activity_description="writing src/x.py")
    # a session with no messages at all: Hermes' own activity description is the only "latest step"
    session("s-quiet", "cli", NOW - 40 * 60, last=NOW - 5 * 60, last_activity_description="thinking about the plan", message_count=0)
    t0 = NOW - 2 * H
    msg("s-running", "user", "please fix the build", t0)
    # a micro-compaction merge of adjacent user turns: the model reads it, nobody typed it, Hermes never paints it
    msg("s-running", "user", "please fix the build\n\n(and keep the tests green)", t0 + 1,
        display_metadata=json.dumps({"model_only": True}))
    # an older, double-encoded metadata row (pre-guard Hermes wrote the JSON as a JSON string): not model-only
    msg("s-running", "user", "keep the tests green", t0 + 2, display_metadata=json.dumps(json.dumps({"task_count": 1})))
    msg("s-running", "assistant", None, t0 + 10, tool_calls=call("terminal", {"command": "make"}, "c1"), finish_reason="tool_calls")
    msg("s-running", "tool", tool_result("built"), t0 + 20, tool_name="terminal", tool_call_id="c1")
    msg("s-running", "assistant", None, t0 + 30, tool_calls=call("write_file", {"path": "src/x.py", "content": "x = 1\ny = 2\n"}, "c2"), finish_reason="tool_calls")
    msg("s-running", "tool", tool_result("", 1, "permission denied"), NOW - 30, tool_name="write_file", tool_call_id="c2")
    # the agent's plan: two todo_list revisions, the newer one wins
    plan = lambda a, b: json.dumps({"todos": [{"id": "1", "content": "run the build", "status": a},
                                             {"id": "2", "content": "fix src/x.py", "status": b},
                                             {"id": "3", "content": "rerun tests", "status": "pending"}],
                                   "revision": 2, "summary": {}})
    msg("s-running", "assistant", None, t0 + 5, tool_calls=call("todo_list", {"todos": []}, "c0"), finish_reason="tool_calls")
    msg("s-running", "tool", plan("in_progress", "pending"), t0 + 6, tool_name="todo_list", tool_call_id="c0")
    msg("s-running", "assistant", None, t0 + 25, tool_calls=call("todo_list", {"todos": []}, "c3"), finish_reason="tool_calls")
    msg("s-running", "tool", plan("completed", "in_progress"), t0 + 26, tool_name="todo_list", tool_call_id="c3")
    # archived (compacted) duplicates of the two tool rows: Hermes keeps them for search, never shows them
    msg("s-running", "tool", tool_result("built"), t0 + 20, tool_name="terminal", tool_call_id="c1", active=0, compacted=1)
    msg("s-running", "tool", tool_result("", 1, "permission denied"), NOW - 30, tool_name="write_file", tool_call_id="c2", active=0, compacted=1)

    # s-waiting: open, Hermes replied with no tool calls → waiting for the human
    session("s-waiting", "telegram", NOW - 3 * H, last=NOW - 10 * 60)
    msg("s-waiting", "user", "what time is it", NOW - 3 * H)
    msg("s-waiting", "assistant", "It is late.", NOW - 10 * 60, finish_reason="stop")

    # ended sessions, one per end reason family
    session("s-orphan-ws", "cli", NOW - 5 * H, NOW - 4 * H, "ws_orphan_reap")
    session("s-orphan-startup", "cli", NOW - 5 * H, NOW - 4 * H, "startup_orphan_reap")
    session("s-tui-close", "tui", NOW - 6 * H, NOW - 5 * H, "tui_close")
    session("s-reset", "telegram", NOW - 6 * H, NOW - 5 * H, "session_reset")
    session("s-done", "telegram", NOW - 7 * H, NOW - 6 * H, "done")
    msg("s-done", "user", "hi", NOW - 7 * H)
    msg("s-done", "assistant", "hello", NOW - 6 * H, finish_reason="stop")

    # compression lineage: s-comp-root ended by compaction, s-comp-tip continues it (no fork marker)
    session("s-comp-root", "telegram", NOW - 10 * H, NOW - 8 * H, "compression", title="long chat")
    msg("s-comp-root", "user", "start of a long chat", NOW - 10 * H)
    msg("s-comp-root", "assistant", None, NOW - 10 * H + 5, tool_calls=call("web_search", {"q": "x"}, "c9"), finish_reason="tool_calls")
    msg("s-comp-root", "tool", tool_result("results"), NOW - 10 * H + 9, tool_name="web_search", tool_call_id="c9")
    session("s-comp-tip", "telegram", NOW - 8 * H, parent="s-comp-root", last=NOW - 20 * 60, title="long chat")
    msg("s-comp-tip", "user", "[compressed summary for the model]", NOW - 8 * H, display_kind="hidden")
    msg("s-comp-tip", "user", "and it continues", NOW - 8 * H + 1)
    msg("s-comp-tip", "user", "[model switched to gpt-5]", NOW - 8 * H + 2, display_kind="model_switch")
    msg("s-comp-tip", "user", "focus on the tests", NOW - 8 * H + 3, display_kind="steer")
    msg("s-comp-tip", "assistant", None, NOW - 25 * 60, finish_reason="tool_calls",
        tool_calls=call("patch", {"path": "src/y.py", "old_string": "a = 1\nb = 2\nc = 3", "new_string": "a = 1\nb = 20\nc = 3\nd = 4"}, "c8"))
    msg("s-comp-tip", "tool", tool_result("patched"), NOW - 25 * 60 + 2, tool_name="patch", tool_call_id="c8")
    msg("s-comp-tip", "assistant", "Still here.", NOW - 20 * 60, finish_reason="stop")
    # a human-made branch of the tip: its own conversation, not a subagent and not a continuation
    session("s-branch", "telegram", NOW - 30 * 60, parent="s-comp-tip", cfg={"_branched_from": "s-comp-tip"}, title="long chat (branch)")
    msg("s-branch", "user", "try another approach", NOW - 30 * 60)
    msg("s-branch", "assistant", "Sure.", NOW - 29 * 60, finish_reason="stop")

    # a real subagent: delegate marker points at its parent
    session("s-sub", "telegram", NOW - 90 * 60, NOW - 80 * 60, "done", parent="s-running",
            cfg={"_delegate_from": "s-running"}, title="Subagent: check tests")
    msg("s-sub", "user", "check tests", NOW - 90 * 60)
    msg("s-sub", "assistant", "all green", NOW - 80 * 60, finish_reason="stop")

    db.execute("insert into session_model_usage (session_id, model, billing_provider, api_call_count, input_tokens, output_tokens, "
               "cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_status) "
               "values ('s-running','gpt-5','openai',5,50000,2000,30000,1000,500,0.12,0.10,'ok')")
    db.execute("insert into session_model_usage (session_id, model, billing_provider, api_call_count, input_tokens, output_tokens, "
               "cache_read_tokens, estimated_cost_usd, cost_status) values ('s-waiting','claude-sonnet','anthropic',2,8000,400,0,0.03,'estimated')")
    try:                                   # Hermes' word index: an external-content FTS5 table over a view of messages
        db.executescript("""
            create view messages_fts_src as select id, case when role = 'tool' then substr(coalesce(content, ''), 1, 4000)
                else content end as content, tool_name, tool_calls from messages;
            create virtual table messages_fts using fts5(content, tool_name, tool_calls, content='messages_fts_src', content_rowid='id');
            insert into messages_fts(messages_fts) values ('rebuild');""")
    except sqlite3.OperationalError:       # SQLite built without FTS5: Keryx falls back to LIKE
        pass
    db.execute("insert into gateway_heartbeats values ('gw1', 123, ?, ?, '', 'host')", (NOW - 86400, NOW - 30))
    db.execute("insert into async_delegations (delegation_id, origin_session, parent_session_id, state, dispatched_at, completed_at, "
               "updated_at, task_json, result_json, delivery_state) values ('d1','s-running','s-running','completed',?,?,?,?,?,'delivered')",
               (NOW - 90 * 60 + 5, NOW - 80 * 60, NOW - 80 * 60, json.dumps({"goal": "check tests"}), json.dumps({"summary": "all green"})))
    db.commit()
    db.close()


def write_cron(cron: Path) -> None:
    cron.mkdir()
    (cron / "jobs.json").write_text(json.dumps({"jobs": [
        {"id": "job-ok", "name": "daily digest", "schedule": {"kind": "cron", "expr": "0 9 * * *", "display": "daily 09:00"},
         "next_run_at": NOW + 3 * H, "last_run_at": NOW - 21 * H, "last_status": "completed", "enabled": True, "prompt": "summarise"},
        {"id": "job-bad", "name": "flaky sync", "schedule": {"kind": "every", "display": "every 1h"},
         "next_run_at": NOW - 2 * H, "last_status": "failed", "last_error": "boom", "failure_streak": 2, "enabled": True, "script": "sync.sh"},
    ]}))
    db = sqlite3.connect(cron / "executions.db")
    db.execute(EXECUTIONS_DDL)
    iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(t))
    db.execute("insert into executions values ('e1','job-ok','scheduler','p',1,'completed',?,?,?,NULL,'delivered',?,NULL)",
               (iso(NOW - 21 * H), iso(NOW - 21 * H), iso(NOW - 21 * H + 40), iso(NOW - 21 * H)))
    db.execute("insert into executions values ('e2','job-bad','scheduler','p',1,'failed',?,?,?,'boom',NULL,?,NULL)",
               (iso(NOW - 3 * H), iso(NOW - 3 * H), iso(NOW - 3 * H + 5), iso(NOW - 3 * H)))
    db.execute("insert into executions values ('e3','job-bad','scheduler','p',1,'missed',?,NULL,NULL,'missed ×2',NULL,?,NULL)",
               (iso(NOW - 1 * H), iso(NOW - 2 * H)))
    db.commit()
    db.close()
    (cron / "ticker_heartbeat").write_text(f"{NOW - 20} 4242")
    db = sqlite3.connect(cron / "incidents.db")
    db.execute("""create table cron_incidents (id text primary key, job_id text not null, error_sig text not null, state text not null,
        failure_type text not null default 'unknown', first_seen_at text not null, last_seen_at text not null, acked_at text,
        alerted_at text, closed_at text, error text not null, output_file text)""")
    db.execute("insert into cron_incidents values ('inc1','job-bad','sig1','alerted','script',?,?,NULL,?,NULL,'boom: exit 1',NULL)",
               (iso(NOW - 3 * H), iso(NOW - 1 * H), iso(NOW - 3 * H)))
    db.execute("insert into cron_incidents values ('inc2','job-ok','sig2','resolved','timeout',?,?,NULL,NULL,NULL,'took too long',NULL)",
               (iso(NOW - 48 * H), iso(NOW - 47 * H)))
    db.commit(); db.close()
    db = sqlite3.connect(cron / "deliveries.db")
    db.execute("""create table deliveries (execution_id text primary key, job_json text not null, content text not null,
        for_failure integer not null default 0, status text not null, owner_process_id text, owner_pid integer,
        owner_started_at integer, created_at text not null, finished_at text, error text)""")
    db.execute("insert into deliveries values ('e1', ?, 'digest text', 0, 'delivered', NULL, NULL, NULL, ?, ?, NULL)",
               (json.dumps({"name": "daily digest"}), iso(NOW - 21 * H), iso(NOW - 21 * H + 50)))
    db.execute("insert into deliveries values ('e2', ?, 'failure note', 1, 'failed', NULL, NULL, NULL, ?, ?, 'chat not found')",
               (json.dumps({"name": "flaky sync"}), iso(NOW - 3 * H), iso(NOW - 3 * H + 10)))
    db.commit(); db.close()


def write_logs(logs: Path) -> None:
    logs.mkdir()
    stamp = lambda t: time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(t))
    (logs / "errors.log").write_text("\n".join([
        f"{stamp(NOW - 600)},123 ERROR cron.jobs: scheduler tick failed",
        f"{stamp(NOW - 500)},456 ERROR [s-running] agent.run: tool write_file failed",
        "Traceback (most recent call last):",
        "  File \"x.py\", line 1",
        f"{stamp(NOW - 400)},789 WARNING [s-waiting] gateway.telegram: slow reply",
        f"{stamp(NOW - 300)},000 INFO hermes: all good",
    ]) + "\n")
    (logs / "gateway.log").write_text(f"{stamp(NOW - 3000)} INFO gateway: [Telegram] Connected to Telegram as @bot\n")


def write_skills(skills: Path) -> None:
    """Hermes' skill ledger (tools/skill_usage.py writes skills/.usage.json)."""
    skills.mkdir()
    iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(t))
    (skills / ".usage.json").write_text(json.dumps({
        "git-workflow": {"use_count": 7, "view_count": 9, "patch_count": 1, "state": "active", "pinned": True,
                         "last_used_at": iso(NOW - 3 * H), "created_at": iso(NOW - 40 * 86400), "archived_at": None},
        "old-skill": {"use_count": 1, "view_count": 1, "patch_count": 0, "state": "archived", "pinned": False,
                      "last_used_at": iso(NOW - 60 * 86400), "created_at": iso(NOW - 90 * 86400), "archived_at": iso(NOW - 50 * 86400)},
        "broken": "not a dict",
    }))


def write_memory(root: Path) -> None:
    """Hermes' memory files (tools/memory_tool_store.py: entries separated by a § line) and the config section."""
    (root / "memories").mkdir()
    (root / "memories" / "MEMORY.md").write_text("The repo uses pytest.\n§\nDeploys go through docker compose on the Proxmox host.\n§\n"
                                                 "[BLOCKED: MEMORY.md entry contained threat pattern(s): x]")
    (root / "memories" / "USER.md").write_text("Prefers short answers.")
    (root / "config.yaml").write_text("model:\n  default: gpt-5\n\nmemory:\n  # notes\n  memory_enabled: true\n"
                                      "  user_profile_enabled: false\n  memory_char_limit: 100   # tiny, for the test\n"
                                      "  user_char_limit: 'abc'\n\nother:\n  memory_char_limit: 5\n")


@pytest.fixture
def hermes_data(tmp_path: Path):
    write_memory(tmp_path)
    write_state_db(tmp_path / "state.db")
    write_cron(tmp_path / "cron")
    write_logs(tmp_path / "logs")
    write_skills(tmp_path / "skills")
    keryx.configure(tmp_path)
    return tmp_path


@pytest.fixture
def client(hermes_data):
    from fastapi.testclient import TestClient
    return TestClient(keryx.app)
