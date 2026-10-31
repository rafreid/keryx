"""Hermes' kanban queue, read-only: lanes, links, runs, the detail drawer and the health check."""
import json

from conftest import keryx


def test_board_lanes(client):
    k = client.get("/api/kanban").json()
    assert k["board"] == "default" and k["board_name"] == "default"
    assert [l["key"] for l in k["lanes"]] == ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"]
    assert k["counts"] == {"triage": 1, "todo": 1, "scheduled": 0, "ready": 1, "running": 2, "blocked": 1, "review": 1, "done": 1, "archived": 1}
    assert k["total"] == 8                                             # archived cards are not on the board
    assert [b["slug"] for b in k["boards"]] == ["default", "research"] and k["boards"][0]["current"] is True
    lanes = {l["key"]: {t["id"]: t for t in l["tasks"]} for l in k["lanes"]}
    ok = lanes["running"]["t-run-ok"]
    assert ok["stale"] is False and ok["session_id"] == "s-running" and ok["comments"] == 2 and ok["runs"] == 1
    assert ok["last_run"]["status"] == "running" and ok["last_run"]["profile"] == "builder" and ok["skills"] == ["git-workflow"]
    assert ok["branch"] == "kanban/t-run-ok" and ok["workspace_kind"] == "worktree"
    assert lanes["running"]["t-run-stale"]["stale"] is True            # heartbeat two hours old
    b = lanes["blocked"]["t-blocked"]
    assert b["parents"] == ["t-todo"] and lanes["todo"]["t-todo"]["children"] == ["t-blocked"]
    assert b["block_kind"] == "parents_not_done" and b["failures"] == 3 and "[redacted]" in b["last_error"] and "sk-abc" not in b["last_error"]
    assert lanes["done"]["t-done"]["last_run"]["summary"] == "Rotated 3 keys." and lanes["done"]["t-done"]["last_run"]["duration"] == 3600
    assert [a["why"] for a in k["attention"]] == ["worker silent", "3 failures in a row"]
    # priority first inside a lane, then oldest first
    assert [t["id"] for t in k["lanes"][1]["tasks"]] == ["t-todo"]


def test_archived_lane_on_request(client):
    k = client.get("/api/kanban?archived=1").json()
    assert k["lanes"][-1]["key"] == "archived" and [t["id"] for t in k["lanes"][-1]["tasks"]] == ["t-arch"]


def test_other_board(client):
    k = client.get("/api/kanban?board=research").json()
    assert k["board"] == "research" and k["board_name"] == "Research" and k["counts"]["todo"] == 1 and k["total"] == 1
    assert client.get("/api/kanban?board=nope").json()["board"] is None


def test_task_detail(client):
    d = client.get("/api/kanban/t-run-ok").json()
    assert d["task"]["id"] == "t-run-ok" and d["task"]["body"] is None
    assert [c["author"] for c in d["comments"]] == ["rafael", "builder"]
    assert [e["kind"] for e in d["events"]] == ["created", "claimed", "commented"]      # oldest first
    assert d["events"][1]["run_id"] == 1 and "builder" in d["events"][1]["detail"]
    assert "sk-abc" not in json.dumps(d)                                               # unknown payload keys are dropped
    assert d["runs"][0]["status"] == "running" and d["attachments"] == 0
    assert client.get("/api/kanban/nope").json()["error"] == "task not found"
    assert "sk-abc" not in json.dumps(client.get("/api/kanban/t-blocked").json())        # run errors are redacted


def test_worker_sessions_carry_their_card(client):
    g = client.get("/api/graph?hours=24").json()
    node = next(n for n in g["nodes"] if n["id"] == "session:s-running")
    assert node["task"] == {"id": "t-run-ok", "title": "Fix the build on main", "status": "running", "board": "default"}
    assert next(n for n in g["nodes"] if n["id"] == "session:s-waiting")["task"] is None


def test_kanban_health_check(hermes_data):
    c = {x["name"]: x for x in keryx.build_status()["checks"]}
    assert c["kanban"]["level"] == "red" and "Index the docs" in c["kanban"]["detail"] and c["kanban"]["board"] == "default"
    assert keryx.build_tasks()["kanban"]["attention"] == 2


def test_no_board_means_no_check(hermes_data):
    (hermes_data / "kanban.db").unlink()
    import shutil
    shutil.rmtree(hermes_data / "kanban")
    keryx.configure(hermes_data)
    assert "kanban" not in {x["name"] for x in keryx.build_status()["checks"]}
    assert keryx.build_kanban()["board"] is None and keryx.build_tasks()["kanban"] is None
    assert keryx.build_kanban_task("t-run-ok")["error"] == "no kanban board"


def test_empty_board_is_quiet(hermes_data):
    import sqlite3
    db = sqlite3.connect(hermes_data / "kanban.db")
    db.execute("delete from tasks"); db.commit(); db.close()
    keryx.configure(hermes_data)
    assert "kanban" not in {x["name"] for x in keryx.build_status()["checks"]}
    assert keryx.build_kanban()["total"] == 0 and keryx.build_kanban()["board"] == "default"


def test_diagnostics_count_the_board(client):
    d = client.get("/api/diagnostics").json()
    assert d["kanban"]["counts"]["running"] == 2 and d["kanban"]["boards"] == 2
    assert "Fix the build on main" not in client.get("/api/diagnostics").text         # titles are content: counts only
