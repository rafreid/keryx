"""Auth middleware, the shared SSE broadcaster, and SQL-side content trimming."""
import asyncio
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from conftest import keryx, tool_result


@pytest.fixture
def locked(hermes_data, monkeypatch):
    monkeypatch.setattr(keryx, "TOKEN", "s3cret")
    return TestClient(keryx.app)


def test_token_required_for_api(locked):
    assert locked.get("/api/graph").status_code == 401
    assert locked.get("/api/graph", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert locked.get("/api/graph", headers={"Authorization": "Bearer s3cret"}).status_code == 200
    assert locked.get("/api/graph", cookies={"keryx_token": "s3cret"}).status_code == 200


def test_query_token_sets_cookie(locked):
    r = locked.get("/api/now?token=s3cret")
    assert r.status_code == 200 and r.cookies.get("keryx_token") == "s3cret"


def test_health_open_but_terse_without_token(locked):
    r = locked.get("/api/health")
    assert r.status_code == 200 and r.json()["ok"] is True and "data" not in r.json()
    assert "data" in locked.get("/api/health", headers={"Authorization": "Bearer s3cret"}).json()


def test_static_app_stays_open(locked):
    assert locked.get("/").status_code in (200, 503)   # the viewer itself (503 when the front end is not built)


def test_no_token_means_open(client):
    assert client.get("/api/graph").status_code == 200


def test_digest_trimming_keeps_failure_detection(hermes_data):
    db = keryx.STATE.get()
    big = "x" * 50_000
    row = db.execute(f"select {keryx.DIGEST_CONTENT_SQL} as c from (select 'tool' as role, ? as content)",
                     (tool_result(big, 1, None),)).fetchone()
    assert len(row["c"]) < 200 and keryx.tool_result_failed(row["c"]) is True
    row = db.execute(f"select {keryx.DIGEST_CONTENT_SQL} as c from (select 'tool' as role, ? as content)",
                     (tool_result(big, 0, None),)).fetchone()
    assert keryx.tool_result_failed(row["c"]) is False
    row = db.execute(f"select {keryx.DIGEST_CONTENT_SQL} as c from (select 'user' as role, ? as content)", (big,)).fetchone()
    assert len(row["c"]) == 400
    row = db.execute(f"select {keryx.DIGEST_CONTENT_SQL} as c from (select 'tool' as role, ? as content)", ("Traceback: boom",)).fetchone()
    assert keryx.tool_result_failed(row["c"]) is True   # non-JSON tool output still goes through the text rule


def test_broadcaster_shares_one_bundle(hermes_data):
    async def run():
        b = keryx.Broadcaster()
        q1 = await b.subscribe(24)
        q2 = await b.subscribe(24)
        first = await asyncio.wait_for(q1.get(), 5)
        assert first.startswith("event: update\ndata: ")
        assert (await asyncio.wait_for(q2.get(), 5)) == first       # second subscriber got the cached event
        payload = json.loads(first.split("data: ", 1)[1])
        assert set(payload) == {"graph", "now", "status", "cost", "tasks"}
        assert b.task is not None and not b.task.done() and set(b.subs) == {24}
        b.unsubscribe(24, q1); b.unsubscribe(24, q2)
        assert not b.subs and 24 not in b.last
        await asyncio.sleep(0)
        b.task.cancel()
    asyncio.run(run())


def test_stream_endpoint_emits_update(hermes_data):
    """Drive the SSE generator directly: Starlette's TestClient cannot close an endless stream."""
    async def run():
        resp = await keryx.api_stream(hours=24)
        assert resp.media_type == "text/event-stream"
        it = resp.body_iterator
        first = await asyncio.wait_for(it.__anext__(), 10)
        assert first.startswith("event: update\ndata: ") and '"graph"' in first
        await it.aclose()                                   # client went away → unsubscribed
        assert not keryx.BROADCAST.subs
    asyncio.run(run())
