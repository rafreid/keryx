from conftest import keryx


def test_parse_plain_line():
    e = keryx.parse_log_line("2026-10-30 10:00:01,123 INFO cron.jobs: tick ok")
    assert e["level"] == "INFO" and e["logger"] == "cron.jobs" and e["msg"] == "tick ok" and e["session"] is None


def test_parse_session_tagged_line():
    e = keryx.parse_log_line("2026-10-30 10:00:02,456 ERROR [a1b2c3d4] agent.run: tool failed")
    assert e["level"] == "ERROR" and e["logger"] == "agent.run" and e["session"] == "a1b2c3d4" and e["msg"] == "tool failed"


def test_parse_continuation_line():
    assert keryx.parse_log_line("Traceback (most recent call last):") is None


def test_build_logs_keeps_levels_of_tagged_lines(hermes_data):
    out = keryx.build_logs("errors", "WARNING", "", 100)
    levels = [e["level"] for e in out["entries"]]
    assert levels == ["ERROR", "ERROR", "WARNING"]
    assert out["counts"]["ERROR"] == 2 and out["counts"]["WARNING"] == 1 and out["counts"]["INFO"] == 1
    tagged = out["entries"][1]
    assert tagged["session"] == "s-running"
    assert "Traceback" in tagged["msg"] and "line 1" in tagged["msg"]   # traceback glued onto its own entry


def test_build_logs_keyword_filter(hermes_data):
    out = keryx.build_logs("errors", "", "telegram", 100)
    assert [e["logger"] for e in out["entries"]] == ["gateway.telegram"]
