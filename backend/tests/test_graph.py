import json
from conftest import keryx


def nodes_by_id(g):
    return {n["id"]: n for n in g["nodes"]}


def test_graph_counts_only_live_message_rows(hermes_data):
    g = keryx.build_graph(24, None)
    n = nodes_by_id(g)["session:s-running"]
    assert n["tool_calls"] == 4            # 2 real + 2 todo_list; the two archived copies are not counted
    assert n["tool_errors"] == 1
    assert n["status"] == "running"
    tools = {t["label"]: t for t in g["nodes"] if t["type"] == "tool" and t["session"] == "s-running"}
    assert tools["terminal"]["calls"] == 1 and tools["write_file"]["errors"] == 1 and tools["todo_list"]["calls"] == 2
    assert [f["path"] for f in n["files"]] == ["src/x.py"]


def test_graph_statuses(hermes_data):
    n = nodes_by_id(keryx.build_graph(24, None))
    assert n["session:s-waiting"]["status"] == "waiting"
    assert n["session:s-orphan-ws"]["status"] == "orphaned"
    assert n["session:s-orphan-startup"]["status"] == "orphaned"
    assert n["session:s-tui-close"]["status"] == "ended_by_user"
    assert n["session:s-reset"]["status"] == "ended_by_user"
    assert n["session:s-done"]["status"] == "ended"


def test_subagent_and_context_gauge(hermes_data):
    n = nodes_by_id(keryx.build_graph(24, None))
    assert n["session:s-sub"]["type"] == "subagent" and n["session:s-sub"]["parent"] == "s-running"
    gauge = n["session:s-running"]["context"]
    assert gauge["prompt_tokens"] == 120000 and gauge["limit"] == 400000 and gauge["pct"] == 30.0


def test_now_lists_open_sessions(hermes_data):
    now = keryx.build_now()
    by = {r["id"]: r for r in now["running"]}
    assert by["s-running"]["status"] == "running" and by["s-waiting"]["status"] == "waiting"
    assert "s-done" not in by


def test_trace_hides_archived_rows(hermes_data):
    tr = keryx.build_trace("s-running", None, 100)
    calls = [s for s in tr["steps"] if s["kind"] == "tool_call" and s["name"] != "todo_list"]
    assert len(calls) == 2
    assert calls[1]["failed"] is True and calls[1]["result"].startswith("error:")


def test_status_checks(hermes_data):
    st = keryx.build_status()
    checks = {c["name"]: c for c in st["checks"]}
    assert checks["gateway"]["level"] == "green"
    assert checks["telegram"]["level"] == "green"
    assert checks["sessions"]["level"] == "amber"       # two orphans in the last 24 h
    assert "2 orphaned" in checks["sessions"]["detail"]
    assert checks["errors"]["errors"] == 2


def test_compression_lineage_is_one_node(hermes_data):
    g = keryx.build_graph(24, None)
    n = nodes_by_id(g)
    assert "session:s-comp-tip" not in n                       # the continuation is folded into its root
    ls = n["session:s-comp-root"]
    assert ls["type"] == "session" and ls["status"] == "waiting"   # status comes from the tip
    assert ls["segments"] == ["s-comp-root", "s-comp-tip"] and ls["compactions"] == 1 and ls["tip"] == "s-comp-tip"
    assert ls["request"] == "start of a long chat"              # request from the root
    assert ls["last_step"] == "Still here."                     # last step from the tip
    assert ls["tool_calls"] == 2 and ls["user_messages"] == 3    # web_search + patch; hidden row skipped; steer counts as a user turn
    assert g["aliases"] == {"session:s-comp-tip": "session:s-comp-root"}
    assert g["stats"]["compactions"] == 1


def test_branch_is_a_session_linked_to_its_parent(hermes_data):
    g = keryx.build_graph(24, None)
    n = nodes_by_id(g)
    assert n["session:s-branch"]["type"] == "session" and n["session:s-branch"]["fork"] == "branch"
    link = next(l for l in g["links"] if l["target"] == "session:s-branch")
    assert link["source"] == "session:s-comp-root" and link["kind"] == "branch"   # parent resolved to the lineage


def test_lineage_helpers():
    root = {"id": "r", "end_reason": "compression", "parent_session_id": None, "fork": None, "started_at": 1, "last_activity_at": 2, "ended_at": 2}
    tip = {"id": "t", "end_reason": None, "parent_session_id": "r", "fork": None, "started_at": 2, "last_activity_at": 3, "ended_at": None}
    fork = {"id": "f", "end_reason": None, "parent_session_id": "r", "fork": "delegate", "started_at": 2, "last_activity_at": 3, "ended_at": None}
    logical, alias = keryx.logical_sessions([tip, root, fork])
    by = {l["id"]: l for l in logical}
    assert set(by) == {"r", "f"} and by["r"]["segments"] == ["r", "t"] and alias == {"r": "r", "t": "r", "f": "f"}
    assert keryx.is_subagent(by["f"], {"r"}) is True and keryx.is_subagent(by["r"], {"r"}) is False


def test_now_folds_lineages(hermes_data):
    by = {r["id"]: r for r in keryx.build_now()["running"]}
    assert "s-comp-tip" not in by and by["s-comp-root"]["compactions"] == 1 and by["s-comp-root"]["status"] == "waiting"


def test_trace_spans_lineage_with_markers(hermes_data):
    for sid in ("s-comp-root", "s-comp-tip"):          # any segment id resolves to the whole lineage
        tr = keryx.build_trace(sid, None, 100)
        assert tr["session"]["id"] == "s-comp-root" and tr["session"]["segments"] == ["s-comp-root", "s-comp-tip"]
        kinds = [s["kind"] for s in tr["steps"]]
        assert kinds == ["user", "tool_call", "compaction", "user", "event", "event", "tool_call", "thinking", "assistant"]
        events = [s for s in tr["steps"] if s["kind"] == "event"]
        assert [e["name"] for e in events] == ["model_switch", "steer"]
        assert "hidden" not in " ".join(s.get("text", "") for s in tr["steps"])


def test_session_columns_from_hermes(hermes_data):
    n = nodes_by_id(keryx.build_graph(24, None))
    r = n["session:s-running"]
    assert r["cwd"] == "/work/repo" and r["git_branch"] == "main" and r["archived"] is False
    assert r["last_step"].startswith("calling write_file")          # digest wins when there are messages
    assert n["session:s-quiet"]["last_step"] == "thinking about the plan"   # else Hermes' own description
    assert r["usage"]["cost_basis"] == "actual" and r["usage"]["cost_usd"] == 0.10 and r["usage"]["reasoning"] == 500


def test_status_cron_reports_open_incident(hermes_data):
    checks = {c["name"]: c for c in keryx.build_status()["checks"]}
    assert checks["cron"]["level"] == "red" and "flaky sync" in checks["cron"]["detail"]
    assert checks["cron"]["incidents"][0]["error"] == "boom: exit 1"


def test_plan_badge_from_latest_todo(hermes_data):
    n = nodes_by_id(keryx.build_graph(24, None))
    plan = n["session:s-running"]["plan"]
    assert plan == {"done": 1, "total": 3, "open": 2, "current": "fix src/x.py", "ts": plan["ts"]}
    assert n["session:s-waiting"]["plan"] is None
    assert n["session:s-running"]["tool_calls"] == 4          # the two todo_list calls count as tool calls
    by = {r["id"]: r for r in keryx.build_now()["running"]}
    assert by["s-running"]["plan"]["current"] == "fix src/x.py"


def test_todo_endpoint_and_parser(hermes_data):
    t = keryx.build_todo("s-running")["todo"]
    assert [i["status"] for i in t["items"]] == ["completed", "in_progress", "pending"] and t["revision"] == 2
    assert t["summary"]["completed"] == 1 and t["current"] == "fix src/x.py"
    assert keryx.build_todo("s-waiting")["todo"] is None
    assert keryx.parse_todo("not json") is None and keryx.parse_todo('{"error": "x"}') is None
    assert keryx.parse_todo('{"todos": [{"id": 1, "content": "a", "status": "bogus"}]}')["items"][0]["status"] == "pending"


def test_analytics_counts_live_rows(hermes_data):
    a = keryx.build_analytics(2)
    assert a["totals"]["tool_calls"] == 6                # s-running 4 + s-comp-root 1 + s-comp-tip 1
    assert a["totals"]["tool_errors"] == 1


def test_model_only_rows_are_never_painted(hermes_data):
    """Hermes' DISPLAY_VISIBLE_SQL rule: a micro-compaction merge row (display_metadata.model_only) is
    read by the model but is not a message anyone typed, so neither the trace nor the digest shows it."""
    tr = keryx.build_trace("s-running", None, 100)
    users = [s["text"] for s in tr["steps"] if s["kind"] == "user"]
    assert users == ["please fix the build", "keep the tests green"]
    n = nodes_by_id(keryx.build_graph(24, None))["session:s-running"]
    assert n["user_messages"] == 2 and n["request"] == "please fix the build"
    a = keryx.build_analytics(2)
    # s-running 2 + s-waiting 1 + s-done 1 + lineage 3 (root, tip, the steer; not the hidden summary or the
    # model-switch event) + s-branch 1 + s-sub 1
    assert a["totals"]["user_messages"] == 9


def test_hidden_rows_sql_degrades_on_old_schemas(tmp_path):
    import sqlite3
    db = sqlite3.connect(":memory:")
    db.execute("create table messages (id integer primary key, session_id text, role text, content text, timestamp real)")
    assert keryx.hidden_rows_sql(db) == ""
    db.execute("alter table messages add column display_kind text")
    assert keryx.hidden_rows_sql(db) == " and coalesce(display_kind, '') <> 'hidden'"
    db.execute("alter table messages add column display_metadata text")
    assert "model_only" in keryx.hidden_rows_sql(db)


def test_trace_steps_carry_kind_title_and_diff(hermes_data):
    tr = keryx.build_trace("s-running", None, 100)
    calls = {s["name"]: s for s in tr["steps"] if s["kind"] == "tool_call"}
    assert calls["terminal"]["tool_kind"] == "shell" and calls["terminal"]["title"] == "make"
    assert calls["terminal"]["exit_code"] == 0 and calls["terminal"]["lines"] == 1
    assert calls["write_file"]["diff"] == {"op": "write", "path": "src/x.py", "added": 2, "removed": 0}
    assert calls["write_file"]["exit_code"] == 1 and calls["write_file"]["failed"] is True
    assert calls["todo_list"]["tool_kind"] == "todo"
    tip = keryx.build_trace("s-comp-tip", None, 100)
    patch = next(s for s in tip["steps"] if s.get("name") == "patch")
    assert patch["tool_kind"] == "edit" and patch["title"] == "src/y.py"
    assert patch["diff"] == {"op": "update", "path": "src/y.py", "added": 2, "removed": 1}
    assert tr["session"]["cwd"] == "/work/repo" and tr["session"]["git_branch"] == "main"


def test_step_titles_and_kinds():
    assert keryx.tool_kind("mcp_github_list_issues") == "mcp" and keryx.tool_kind("nonsense") == "other"
    assert keryx.step_title("terminal", {"command": "  \ncd x && make\nmake test"}) == "cd x && make"
    assert keryx.step_title("search_files", {"pattern": "TODO", "path": "src"}) == "TODO in src"
    assert keryx.step_title("web_extract", {"urls": ["https://a.example/x"]}) == "https://a.example/x"
    assert keryx.step_title("delegate_task", {"tasks": [{"goal": "check tests"}, {"goal": "lint"}]}) == "check tests (+1 more)"
    assert keryx.step_title("clarify", {"questions": [{"question": "which branch?"}]}) == "which branch?"
    assert keryx.step_title("memory", {"action": "add", "target": "user"}) == "add user"
    assert keryx.diff_summary("patch", {"path": "f", "old_string": "", "new_string": "a\nb"}) == {"op": "update", "path": "f", "added": 2, "removed": 0}
    assert keryx.diff_summary("read_file", {"path": "f"}) is None


def test_files_carry_line_counts(hermes_data):
    n = nodes_by_id(keryx.build_graph(24, None))["session:s-running"]
    assert n["files"] == [{"path": "src/x.py", "op": "write", "added": 2, "removed": 0, "ts": n["files"][0]["ts"]}]


def test_analytics_heatmap_and_skills(hermes_data):
    a = keryx.build_analytics(7)
    hm = a["heatmap"]
    assert hm["weeks"] == 53 and len(hm["days"]) % 7 == 0 and len(hm["days"]) == 53 * 7
    from datetime import date
    assert date.fromisoformat(hm["start"]).weekday() == 0          # Monday-aligned grid
    by = {d["day"]: d for d in hm["days"]}
    import time
    today = time.strftime("%Y-%m-%d", time.gmtime())
    recent = sum(d["sessions"] for d in hm["days"])
    assert recent == 15                                              # every fixture session started within the last day or so
    assert sum(d["tool_calls"] for d in hm["days"]) == 0             # fixture sessions carry no tool_call_count column values
    assert sum(d["tokens"] for d in hm["days"]) == 50000 + 2000 + 30000 + 8000 + 400
    assert round(sum(d["cost_usd"] for d in hm["days"]), 2) == 0.13   # 0.10 actual + 0.03 estimated
    assert hm["streak"] >= 1 and hm["active_days"] >= 1
    assert today in by
    assert sum(d["cost_usd"] for d in a["days"]) == 0.13             # per-day cost in the window too
    skills = a["skills"]
    assert [k["name"] for k in skills] == ["git-workflow", "old-skill"]   # the non-dict entry is dropped
    assert skills[0]["uses"] == 7 and skills[0]["pinned"] is True and skills[1]["archived"] is True
    assert a["totals"]["skills"] == 2 and a["totals"]["skills_used"] == 1


def test_streak_counts_back_from_today():
    days = [{"day": f"d{i}", "sessions": n} for i, n in enumerate([1, 0, 1, 1, 1])]
    assert keryx._streak(days, "d4") == 3
    days[4]["sessions"] = 0
    assert keryx._streak(days, "d4") == 2                            # a quiet day so far does not break it
    assert keryx._streak(days, "nope") == 0


def test_trace_carries_the_models_reasoning(hermes_data):
    tr = keryx.build_trace("s-running", None, 100)
    th = [s for s in tr["steps"] if s["kind"] == "thinking"]
    assert len(th) == 1 and tr["thinking"] == 1
    assert th[0]["text"].startswith("The build passed") and th[0]["truncated"] is False and th[0]["chars"] == 72
    i = tr["steps"].index(th[0])
    assert tr["steps"][i + 1]["kind"] == "tool_call" and tr["steps"][i + 1]["name"] == "write_file"    # before the call it led to
    tr = keryx.build_trace("s-comp-root", None, 100)                 # reasoning_content, long: head only
    th = [s for s in tr["steps"] if s["kind"] == "thinking"][0]
    assert th["chars"] == 2002 and th["truncated"] is True and len(th["text"]) <= keryx.THINKING_CHARS + 1
    assert not [s for s in keryx.build_trace("s-running", "write_file", 100)["steps"] if s["kind"] == "thinking"]   # the flat tool list stays flat


def test_trace_without_reasoning_columns(tmp_path):
    import sqlite3
    db = sqlite3.connect(tmp_path / "state.db")
    db.execute("create table sessions (id text primary key, source text, started_at real, ended_at real, end_reason text, title text, last_activity_at real, message_count integer)")
    db.execute("create table messages (id integer primary key, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real, token_count integer, finish_reason text)")
    db.execute("insert into sessions values ('old', 'cli', 1, 2, 'done', 'old', 2, 2)")
    db.execute("insert into messages (session_id, role, content, timestamp) values ('old', 'user', 'hi', 1), ('old', 'assistant', 'hello', 2)")
    db.commit(); db.close()
    keryx.configure(tmp_path)
    tr = keryx.build_trace("old", None, 10)
    assert [s["kind"] for s in tr["steps"]] == ["user", "assistant"] and tr["thinking"] == 0


def test_hermes_session_flags_reach_the_nodes(hermes_data):
    n = nodes_by_id(keryx.build_graph(24, None))
    assert n["session:s-pinned"]["pinned"] is True and n["session:s-pinned"]["hidden"] is False and n["session:s-pinned"]["internal"] is False
    assert n["session:s-hidden"]["hidden"] is True
    assert n["session:s-oneshot"]["internal"] is True and n["session:s-running"]["internal"] is False
    assert n["session:s-running"]["pinned"] is False
    d = keryx.build_diagnostics()
    assert d["sessions"]["flags"] == {"pinned": 1, "hidden": 1, "archived": 0, "internal": 1}


def test_context_window_comes_from_hermes_when_it_can(hermes_data):
    n = nodes_by_id(keryx.build_graph(24, None))
    g = n["session:s-running"]["context"]                      # gpt-5: not cached, not in config → built-in table
    assert g["limit"] == 400000 and g["source"] == "table" and g["assumed"] is False
    g = n["session:s-waiting"]["context"]                      # claude-sonnet@anthropic: Hermes' probed window wins over the table
    assert g["limit"] == 250000 and g["source"] == "cache" and g["pct"] == 20.0
    cache = keryx.load_context_cache()
    assert cache == {"claude-sonnet@https://api.anthropic.com/v1": 250000, "local/qwen@http://127.0.0.1:12434/v1": 64000}
    assert keryx.model_config_section() == {"default": "gpt-5", "provider": "openai", "base_url": None, "context_length": None}


def test_context_limit_resolution_order():
    cfg = {"default": "gpt-5", "provider": "openai", "base_url": None, "context_length": 300000}
    cache = {"gpt-5@https://api.openai.com/v1": 272000, "mystery@https://x": 9000}
    assert keryx.context_limit("gpt-5", None, cfg, cache) == (300000, "config")          # explicit config beats everything
    assert keryx.context_limit("claude-opus", None, cfg, cache) == (200000, "table")      # config applies to the default model only
    cfg["context_length"] = None
    assert keryx.context_limit("gpt-5", "https://api.openai.com/v1/", cfg, cache) == (272000, "cache")   # trailing slash tolerated
    assert keryx.context_limit("gpt-5", None, cfg, cache) == (272000, "cache")            # any base_url for that model
    assert keryx.context_limit("mystery", None, cfg, cache) == (9000, "cache")
    assert keryx.context_limit("never-seen", None, cfg, cache) == (keryx.CONTEXT_LENGTH, "assumed")
    assert keryx.context_limit(None, None, {"default": None, "context_length": 123}, {}) == (123, "config")


def test_analytics_cards(hermes_data):
    a = keryx.build_analytics(30)
    prov = {p["provider"]: p for p in a["providers"]}
    assert prov["openai"]["tokens"] == 52000 and prov["openai"]["cost_usd"] == 0.10 and prov["openai"]["models"] == 1
    assert prov["anthropic"]["share"] + prov["openai"]["share"] == 1.0 and a["providers"][0]["provider"] == "openai"
    c = a["clock"]
    assert len(c["hours"]) == 24 and sum(h["sessions"] for h in c["hours"]) == a["totals"]["sessions"]
    assert sum(h["tool_calls"] for h in c["hours"]) == a["totals"]["tool_calls"] == sum(map(sum, c["grid"]))
    assert c["tz"] == "UTC" and c["peak_hour"] is not None and c["max"] >= 1
    v = a["velocity"]
    assert len(v["spark"]) == 30 and v["per_day"] == a["totals"]["sessions_per_day"]
    assert v["delta_pct"] is None or v["delta_pct"] > 0                                   # everything happened in the last two days
    assert any(i["text"].startswith("Usage peaked on") and "gpt-5" in i["text"] for i in a["insights"])
    assert any(i["text"].startswith("Top skill: git-workflow") for i in a["insights"])
    assert len(a["insights"]) <= 3


def test_velocity_and_insights_edge_cases():
    assert keryx.velocity_of([], 7)["delta_pct"] is None
    rows = [{"sessions": n} for n in (0, 0, 0, 0, 2, 2, 2, 2)]
    v = keryx.velocity_of(rows, 8)
    assert v["prior_per_day"] == 0 and v["recent_per_day"] == 2 and v["delta_pct"] is None   # no prior: no percentage
    rows = [{"sessions": n} for n in (1, 1, 1, 1, 2, 2, 2, 2)]
    assert keryx.velocity_of(rows, 8)["delta_pct"] == 100
    quiet = {"days": [], "models": [], "velocity": {"delta_pct": None}}
    assert keryx.insights_of(quiet, [], 0) == []


def test_context_breakdown(hermes_data):
    c = keryx.build_context("s-running")
    assert c["segment"] == "s-running" and c["rows"] == 11                       # live rows only: archived copies are not counted
    parts = {p["kind"]: p for p in c["parts"]}
    # the model-only merge row is hidden from readers but is in the model's context, so it counts here
    assert parts["tools"]["count"] == 4 and parts["calls"]["count"] == 4 and parts["user"]["count"] == 3 and parts["summary"]["chars"] == 0
    assert abs(sum(p["share"] for p in c["parts"]) - 1.0) < 0.01 and c["est_tokens"] == c["total_chars"] // 4
    tools = {t["name"]: t for t in c["tools"]}
    assert tools["todo_list"]["calls"] == 2 and tools["todo_list"]["kind"] == "todo" and c["tools"][0]["name"] == "todo_list"
    assert c["biggest"][0]["name"] == "todo_list" and c["biggest"][0]["chars"] > 0
    assert c["gauge"]["pct"] == 30.0
    # a compacted lineage reports its current segment, and its summary row counts as context
    c = keryx.build_context("s-comp-root")
    assert c["segment"] == "s-comp-tip" and c["segments"] == ["s-comp-root", "s-comp-tip"]
    assert {p["kind"]: p for p in c["parts"]}["summary"]["count"] == 1
    assert keryx.build_context("nope")["rows"] == 0


def test_achievements_from_the_plugin_state(hermes_data):
    a = keryx.build_analytics(30)["achievements"]
    assert a["unlocked"] == 2 and [x["id"] for x in a["recent"]] == ["night-owl", "claude_confidant"]
    assert a["recent"][0] == {"id": "night-owl", "name": "night owl", "tier": "Silver", "unlocked_at": a["recent"][0]["unlocked_at"]}
    assert "s-x" not in json.dumps(a)                                           # evidence stays on disk
    (hermes_data / "plugin-data" / "hermes-achievements" / "state.json").write_text("{}")
    keryx.configure(hermes_data)
    assert keryx.build_analytics(30)["achievements"] is None
