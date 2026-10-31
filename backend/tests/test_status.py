import json
import time

import pytest
from conftest import keryx


def ended(reason):
    return {"ended_at": 1.0, "started_at": 0.0, "last_activity_at": 1.0, "end_reason": reason}


@pytest.mark.parametrize("reason", ["startup_orphan_reap", "ws_orphan_reap"])
def test_orphan_reasons(reason):
    assert keryx.session_status(ended(reason), 10.0, {}) == "orphaned"


@pytest.mark.parametrize("reason", ["cli_close", "tui_close", "tui_shutdown", "user_exit", "session_reset", "ws_disconnect"])
def test_user_close_reasons(reason):
    assert keryx.session_status(ended(reason), 10.0, {}) == "ended_by_user"


def test_plain_end():
    assert keryx.session_status(ended("done"), 10.0, {}) == "ended"
    assert keryx.session_status(ended(None), 10.0, {}) == "ended"


def test_failed_needs_errors_and_tool_calls_finish():
    assert keryx.session_status(ended("done"), 10.0, {"tool_errors": 1, "finish": "tool_calls"}) == "failed"
    assert keryx.session_status(ended("done"), 10.0, {"tool_errors": 1, "finish": "stop"}) == "ended"


def test_open_session_states():
    s = {"ended_at": None, "started_at": 0.0, "last_activity_at": 100.0, "end_reason": None}
    assert keryx.session_status(s, 110.0, {"final_reply": False}) == "running"
    assert keryx.session_status(s, 110.0, {"final_reply": True}) == "waiting"
    assert keryx.session_status(s, 100.0 + keryx.STALE_AFTER + 1, {"final_reply": False}) == "stale"


@pytest.mark.parametrize("content,failed", [
    ('{"output": "ok", "exit_code": 0, "error": null}', False),
    ('{"output": "", "exit_code": 1, "error": null}', True),
    ('{"output": "", "exit_code": 0, "error": "nope"}', True),
    ('{"output": "Traceback (most recent call last):\\n boom"}', True),
    ("plain text result", False),
    ("Error: something", True),
    ("", False),
])
def test_tool_result_failed(content, failed):
    assert keryx.tool_result_failed(content) is failed


def test_storage_check(hermes_data, monkeypatch):
    from conftest import keryx
    st = {c["name"]: c for c in keryx.build_status()["checks"]}["storage"]
    assert st["level"] == "green" and st["db"] > 0 and st["wal"] == 0 and st["logs"] > 0
    assert "state.db" in st["detail"] and ("free" in st["detail"] or st["free"] is None)
    # a swollen WAL is a warning, a nearly full disk is red
    monkeypatch.setattr(keryx, "storage_state", lambda: {"db": 1, "wal": 300 << 20, "logs": 0, "free": 50 << 30, "total": 100 << 30, "free_pct": 50.0})
    assert {c["name"]: c for c in keryx.build_status()["checks"]}["storage"]["level"] == "amber"
    monkeypatch.setattr(keryx, "storage_state", lambda: {"db": 1, "wal": 0, "logs": 0, "free": 500 << 20, "total": 100 << 30, "free_pct": 0.5})
    assert {c["name"]: c for c in keryx.build_status()["checks"]}["storage"]["level"] == "red"
    assert keryx.fmt_bytes(1536) == "2 KB" and keryx.fmt_bytes(5 << 30) == "5.0 GB" and keryx.fmt_bytes(None) == "?"


def checks():
    return {c["name"]: c for c in keryx.build_status()["checks"]}


def test_platform_checks_come_from_the_gateway_state_file(hermes_data):
    st = keryx.build_status()
    c = checks()
    assert c["telegram"]["level"] == "green" and c["telegram"]["kind"] == "platform" and c["telegram"]["detail"].startswith("connected")
    assert c["webhook"]["level"] == "green"
    assert c["api_server"]["level"] == "green" and "1 active run" in c["api_server"]["detail"] and "12 request" in c["api_server"]["detail"]
    w = c["whatsapp"]
    assert w["level"] == "amber" and w["state"] == "retrying" and w["error_code"] == "whatsapp_bridge_exited"
    assert w["detail"].startswith("retrying since 9d ago") and "bridge process exited" in w["detail"]
    assert "abc123" not in w["detail"]                               # error text is redacted before it leaves the server
    assert "SECRET-ARGV" not in json.dumps(st)                       # argv never leaves gateway_summary
    assert c["gateway"]["level"] == "green" and c["gateway"]["detail"].endswith("Hermes 0.22.2")
    assert st["hermes"]["version"] == "0.22.2" and st["hermes"]["state"] == "running" and st["hermes"]["sha"] == "d923a5eb487a"
    assert st["hermes"]["profiles"] == ["default"] and st["hermes"]["stale"] is False


def test_gateway_state_outranks_the_heartbeat(hermes_data):
    from conftest import write_gateway_state
    write_gateway_state(hermes_data, gateway_state="degraded")           # partial start: amber even with a fresh heartbeat
    keryx.configure(hermes_data)
    g = checks()["gateway"]
    assert g["level"] == "amber" and g["detail"].startswith("gateway degraded")
    write_gateway_state(hermes_data, gateway_state="startup_failed", desired_state="running", exit_reason="boom")
    keryx.configure(hermes_data)
    g = checks()["gateway"]
    assert g["level"] == "red" and g["detail"].startswith("gateway startup_failed, wanted running")
    write_gateway_state(hermes_data, gateway_state="stopped", desired_state="stopped")
    keryx.configure(hermes_data)
    assert checks()["gateway"]["detail"].startswith("gateway stopped") and "wanted" not in checks()["gateway"]["detail"]


def test_stale_gateway_state_file_is_only_a_warning(hermes_data):
    from conftest import write_gateway_state, NOW
    iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(t))
    write_gateway_state(hermes_data, updated_at=iso(NOW - 2 * 3600))
    keryx.configure(hermes_data)
    g = checks()["gateway"]
    assert g["level"] == "amber" and "state file 120m old" in g["detail"]
    assert keryx.build_status()["hermes"]["stale"] is True


def test_needs_attention_is_red(hermes_data):
    from conftest import write_gateway_state
    import json as _json
    base = _json.loads((hermes_data / "gateway_state.json").read_text())
    base["platforms"]["telegram"].update(needs_attention=True, state="connected")
    (hermes_data / "gateway_state.json").write_text(_json.dumps(base))
    keryx.configure(hermes_data)
    assert checks()["telegram"]["level"] == "red"


def test_without_the_state_file_telegram_comes_from_the_log(hermes_data):
    (hermes_data / "gateway_state.json").unlink()
    keryx.configure(hermes_data)
    st = keryx.build_status()
    c = {x["name"]: x for x in st["checks"]}
    assert st["hermes"] is None and "whatsapp" not in c
    assert c["telegram"]["level"] == "green" and c["telegram"]["detail"].startswith("connected") and c["telegram"]["kind"] == "platform"
    assert c["gateway"]["detail"].startswith("heartbeat") and "Hermes" not in c["gateway"]["detail"]
    (hermes_data / "gateway_state.json").write_text("{not json")       # a half-written file is the same as no file
    keryx.configure(hermes_data)
    assert keryx.build_status()["hermes"] is None


def test_diagnostics_carry_hermes_state(client):
    d = client.get("/api/diagnostics").json()
    assert d["hermes"]["version"] == "0.22.2"
    plats = {p["name"]: p for p in d["hermes"]["platforms"]}
    assert plats["whatsapp"]["state"] == "retrying" and "abc123" not in plats["whatsapp"]["error"]
    assert "argv" not in json.dumps(d["hermes"]) and "SECRET-ARGV" not in client.get("/api/diagnostics").text


def test_restart_pending_is_a_warning(hermes_data):
    from conftest import write_gateway_state
    write_gateway_state(hermes_data, restart_requested=True)
    keryx.configure(hermes_data)
    g = checks()["gateway"]
    assert g["level"] == "amber" and g["detail"].startswith("restart pending") and g["restart_requested"] is True
    assert keryx.build_status()["hermes"]["restart_requested"] is True


def test_attention_list_ranks_what_needs_a_look(hermes_data):
    st = keryx.build_status()
    att = st["attention"]
    sev = [a["severity"] for a in att]
    assert sev == sorted(sev, key={"red": 0, "amber": 1, "info": 2}.get)            # red first, info last
    by = {a["id"]: a for a in att}
    assert by["incident-inc1"]["node"] == "cron:job-bad" and by["incident-inc1"]["label"] == "cron job failing: flaky sync"
    assert "missed-job-bad" not in by                                                 # one line per job: the incident already names it
    assert by["platform-whatsapp"]["severity"] == "amber" and by["platform-whatsapp"]["label"] == "whatsapp retrying"
    assert by["kanban-t-run-stale"]["severity"] == "red" and by["kanban-t-run-stale"]["tab"] == "board"
    assert by["kanban-t-blocked"]["severity"] == "amber" and by["kanban-blocked"]["label"].startswith("1 kanban card")
    assert by["deliveries"]["label"].startswith("1 cron result") and by["deliveries"]["tab"] == "tasks"
    assert by["errors"]["severity"] == "amber" and by["errors"]["tab"] == "logs"
    assert by["orphans"]["label"].startswith("2 session") and by["waiting"]["severity"] == "info"
    assert "gateway" not in by and "restart" not in by                                # green gateway stays out
    assert all(a["node"] or a["tab"] for a in att)                                     # every line leads somewhere


def test_attention_includes_restart_and_gateway_trouble(hermes_data):
    from conftest import write_gateway_state
    write_gateway_state(hermes_data, restart_requested=True, gateway_state="degraded")
    keryx.configure(hermes_data)
    by = {a["id"]: a for a in keryx.build_status()["attention"]}
    assert by["restart"]["severity"] == "amber" and by["gateway"]["label"].startswith("gateway: gateway degraded")


def test_diagnostics_carry_attention(client):
    d = client.get("/api/diagnostics").json()
    assert any(a["source"] == "cron" and a["severity"] == "red" for a in d["attention"])
    assert "node" not in d["attention"][0]


def test_plurals_are_real_words():
    assert keryx.plural(1, "job") == "1 job" and keryx.plural(2, "job") == "2 jobs" and keryx.plural(0, "result") == "0 results"
    assert keryx.plural(None, "incident") == "0 incidents" and keryx.plural(3, "entry", "entries") == "3 entries"
    import json
    assert "(s)" not in json.dumps(keryx.build_status())                  # nothing user-facing says "job(s)" any more
