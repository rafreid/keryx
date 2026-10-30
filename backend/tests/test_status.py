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
