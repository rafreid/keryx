from conftest import keryx


def nodes_by_id(g):
    return {n["id"]: n for n in g["nodes"]}


def test_graph_counts_only_live_message_rows(hermes_data):
    g = keryx.build_graph(24, None)
    n = nodes_by_id(g)["session:s-running"]
    assert n["tool_calls"] == 2            # the two archived copies are not counted
    assert n["tool_errors"] == 1
    assert n["status"] == "running"
    tools = {t["label"]: t for t in g["nodes"] if t["type"] == "tool" and t["session"] == "s-running"}
    assert tools["terminal"]["calls"] == 1 and tools["write_file"]["errors"] == 1
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
    calls = [s for s in tr["steps"] if s["kind"] == "tool_call"]
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
    assert ls["tool_calls"] == 1 and ls["user_messages"] == 3    # hidden row skipped; steer counts as a user turn
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
        assert kinds == ["user", "tool_call", "compaction", "user", "event", "event", "assistant"]
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


def test_analytics_counts_live_rows(hermes_data):
    a = keryx.build_analytics(2)
    assert a["totals"]["tool_calls"] == 3                # s-running 2 + s-comp-root 1
    assert a["totals"]["tool_errors"] == 1
