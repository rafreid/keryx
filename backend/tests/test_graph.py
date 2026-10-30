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


def test_analytics_counts_live_rows(hermes_data):
    a = keryx.build_analytics(2)
    assert a["totals"]["tool_calls"] == 3                # s-running 2 + s-comp-root 1
    assert a["totals"]["tool_errors"] == 1
