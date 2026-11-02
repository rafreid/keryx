#!/usr/bin/env python3
"""Build a synthetic Hermes data directory for local Keryx runs and screenshots.

Reuses the writers in backend/tests/conftest.py so the demo data is exactly what the tests cover.
Usage: backend/.venv/bin/python .claude/skills/demo-data/make_demo_data.py <target-dir>

The target is created if missing. An existing target is replaced only when it contains the
`.keryx-demo` marker this script leaves behind, so the script can never remove real Hermes data.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "backend" / "tests"))

MARKER = ".keryx-demo"


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    target = Path(argv[1]).expanduser().resolve()
    if target.exists():
        if not (target / MARKER).exists():
            print(f"refusing to replace {target}: no {MARKER} marker (not a demo directory)", file=sys.stderr)
            return 1
        shutil.rmtree(target)
    target.mkdir(parents=True)

    import conftest as fx  # noqa: E402  (needs backend/ and backend/tests on sys.path)

    fx.write_memory(target)
    fx.write_achievements(target)
    fx.write_gateway_state(target)
    fx.write_kanban(target)
    fx.write_state_db(target / "state.db")
    fx.write_cron(target / "cron")
    fx.write_logs(target / "logs")
    fx.write_skills(target / "skills")
    (target / MARKER).write_text("synthetic Keryx demo data; safe to delete\n")

    print(f"demo data written to {target}")
    print(f"run: cd backend && HERMES_DATA={target} KERYX_SHOW_MEMORY=1 .venv/bin/uvicorn app:app --port 9121")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
