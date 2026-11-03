# Contributing to Keryx

Issues and pull requests are welcome. Keryx is small and opinionated, so a few rules save everyone time.

## The one rule

**Keryx never writes to Hermes' data.** Every feature is observation only. A change that would make
Keryx mutate sessions, tasks, config or memory, or call the agent, will not be merged, however useful.

## Before you open an issue

- Attach `/api/diagnostics` (the ⤓ link in the overview tab). It is redacted: counts, versions,
  states and ids, no message content, no memory, no keys.
- Say which Hermes version you run (`hermes --version` or the header of Keryx shows it) and whether
  Hermes is native or in Docker.
- Check the [troubleshooting table](README.md#troubleshooting) first; most "it shows nothing" reports
  are a data path or a uid.

## Developing

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest
cd frontend && npm install && npm test && npm run build
```

Never point a dev server at real Hermes data for screenshots or fixtures; `backend/tests/conftest.py`
builds a synthetic data directory and `.claude/skills/demo-data/make_demo_data.py` makes a bigger one.

## Pull requests

- One concern per PR, on a branch named `feat/…`, `fix/…`, `docs/…` or `chore/…`.
- Backend and frontend changes come with tests. CI runs `backend`, `frontend` and `image`; all three
  must be green.
- Both themes and the phone layout are first-class: check 1440×900 dark, 1440×900 light and 400×800
  before calling a UI change done.
- Every error string a client can see goes through `redact()`; `/api/diagnostics` must never include
  message or memory content.
- Keep `README.md` and `docs/index.html` in step when a feature ships, and add a line to `CHANGELOG.md`.
- Commit messages: imperative subject, a body that explains why.

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE).
