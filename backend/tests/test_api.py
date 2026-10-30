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


def test_logs_endpoint_exposes_session(client):
    out = client.get("/api/logs?file=errors&level=ERROR").json()
    assert [e["session"] for e in out["entries"]] == [None, "s-running"]


def test_diagnostics_is_redacted(client):
    r = client.get("/api/diagnostics")
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    body = r.text
    assert "please fix the build" not in body        # no prompt content
    assert "s-running" in body                        # ids are fine


def test_replay_graph(client):
    g = client.get("/api/graph?hours=24&at=1").json()
    assert g["replay"] is True and g["stats"]["sessions"] == 0
