def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["state_db"] is True


def test_graph_endpoint(client):
    g = client.get("/api/graph?hours=24").json()
    assert g["stats"]["sessions"] >= 8 and any(n["id"] == "hermes" for n in g["nodes"])


def test_tasks_endpoint(client):
    t = client.get("/api/tasks").json()
    jobs = {j["id"]: j for j in t["jobs"]}
    assert jobs["job-bad"]["state"] == "error" and jobs["job-ok"]["state"] == "scheduled"
    assert t["scheduler"]["alive"] is True
    assert t["delegations"][0]["state"] == "completed"
    assert jobs["job-bad"]["missed"] is True and jobs["job-bad"]["missed_count"] == 1    # from the ledger's `missed` row
    assert jobs["job-ok"]["missed"] is False
    assert [i["state"] for i in jobs["job-bad"]["incidents"]] == ["alerted"]
    assert [i["id"] for i in t["incidents"]] == ["inc1", "inc2"] and t["incidents"][0]["job"] == "flaky sync"
    assert t["deliveries"]["failed"] == 1 and t["deliveries"]["delivered"] == 1
    assert t["deliveries"]["recent"][0]["job"] == "flaky sync" and t["deliveries"]["recent"][0]["error"] == "chat not found"


def test_cost_basis(client):
    c = client.get("/api/cost?hours=24").json()
    by = {m["model"]: m for m in c["models"]}
    assert by["gpt-5"]["cost_basis"] == "actual" and by["gpt-5"]["cost_usd"] == 0.10 and by["gpt-5"]["reasoning"] == 500
    assert by["claude-sonnet"]["cost_basis"] == "estimated" and by["claude-sonnet"]["cost_usd"] == 0.03
    assert c["totals"]["cost_basis"] == "mixed" and c["totals"]["cache_write"] == 1000


def test_log_files_are_discovered(client):
    out = client.get("/api/logs?file=gateway&level=INFO").json()
    assert [f["key"] for f in out["files"]] == ["errors", "gateway"]
    assert out["entries"][0]["msg"].startswith("[Telegram]")
    out = client.get("/api/logs?file=nonexistent").json()
    assert out["file"] == "errors.log"                 # unknown name falls back to the error log


def test_logs_endpoint_exposes_session(client):
    out = client.get("/api/logs?file=errors&level=ERROR").json()
    assert [e["session"] for e in out["entries"]] == [None, "s-running"]


def test_todo_endpoint(client):
    t = client.get("/api/session/s-running/todo").json()
    assert t["session"] == "s-running" and t["todo"]["summary"]["total"] == 3


def test_dashboard_links(client, monkeypatch):
    assert client.get("/api/status").json()["links"] is None
    from conftest import keryx
    monkeypatch.setattr(keryx, "DASHBOARD_URL", "http://hermes:9119")
    keryx.configure(keryx.DATA)                         # drop the cached status
    links = client.get("/api/status").json()["links"]
    assert links["chat_resume"] == "http://hermes:9119/chat?resume=" and links["cron"] == "http://hermes:9119/cron"


def test_diagnostics_is_redacted(client):
    r = client.get("/api/diagnostics")
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    body = r.text
    assert "please fix the build" not in body        # no prompt content
    assert "s-running" in body                        # ids are fine


def test_replay_graph(client):
    g = client.get("/api/graph?hours=24&at=1").json()
    assert g["replay"] is True and g["stats"]["sessions"] == 0


def test_search_finds_sessions_by_conversation(client):
    out = client.get("/api/search?q=long chat").json()
    assert out["engine"] in ("fts5", "like")
    ids = [h["id"] for h in out["sessions"]]
    assert ids == ["s-comp-root"]                                   # both segments of the lineage fold into the root
    hit = out["sessions"][0]
    assert hit["hits"] == 1 and hit["snippets"][0]["role"] == "user"
    assert "[long]" in hit["snippets"][0]["text"] or "long chat" in hit["snippets"][0]["text"]   # FTS5 marks tokens; LIKE does not
    # the hidden compressed summary and tool output never match; the model-only merge never matches
    assert client.get("/api/search?q=compressed summary").json()["sessions"] == []
    assert client.get("/api/search?q=keep the tests").json()["sessions"][0]["id"] == "s-running"
    assert client.get("/api/search?q=x").json()["sessions"] == []   # too short
    assert client.get("/api/search?q=%22build%22%20OR%20(").json()["rows"] >= 0   # FTS syntax is matched literally, never raises


def test_fts_query_quotes_tokens():
    from conftest import keryx
    assert keryx.fts_query('fix the-build NOT "x"') == '"fix" "the-build" "NOT" "x"'
    assert keryx.fts_query("") == ""


def test_search_like_fallback(hermes_data, monkeypatch):
    from conftest import keryx
    monkeypatch.setattr(keryx, "has_fts", lambda db: False)
    out = keryx.build_search("fix the build", 10)
    assert out["engine"] == "like" and [h["id"] for h in out["sessions"]] == ["s-running"]
    assert keryx.build_search("100%", 10)["sessions"] == []        # LIKE wildcards are escaped
