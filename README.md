# Universal QA MCP

A framework-independent MCP server for Claude Code that audits web pages for layout defects
deterministically: DOM geometry measured in a real Chromium, re-confirmed in the live page, and reported
with selectors, measurements, screenshots, reproduction steps, severity, confidence and a
verified / potential / blocked status.

Two modules:

- **Layout engine** (`qa_*` tools) — geometry-based UI defect detection.
  See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Browser operator** (`ui_*` tools) — verified interaction with authorised apps: isolated role sessions,
  workflows, safe state-graph exploration, write approval, duplicate-submission prevention, bounded safe retries,
  operator hand-off for CAPTCHA/MFA/blocked access. See [docs/OPERATOR.md](docs/OPERATOR.md).

## Requirements

- Node.js ≥ 22.12 (developed on 26.13)
- Playwright's Chromium: `npx playwright install chromium` (falls back to an installed Chrome if missing;
  force a channel with `QA_MCP_BROWSER_CHANNEL=chrome`)

## Build and test

```bash
npm install
npx playwright install chromium
npm run build
npm test            # unit + acceptance (broken/clean fixtures) + MCP stdio end-to-end
```

## Use with Claude Code

Not registered automatically. To add it (user scope):

```bash
claude mcp add universal-qa -- node <path-to>/universal-qa-mcp/dist/index.js
```

To audit a non-loopback application you are authorised to test, add its origin:

```bash
claude mcp add universal-qa -e QA_MCP_ALLOWED_ORIGINS=https://staging.example.com -- node <path-to>/universal-qa-mcp/dist/index.js
```

### Tools

| Tool | Purpose |
|---|---|
| `qa_audit_layout` | Audit a URL at several viewports × zoom levels (default 375×812, 768×1024, 1280×800 @ 100%). Optional setup `actions` (e.g. open a dropdown), `checks` subset, `ignoreSelectors`, `includeImages`. Returns a structured report (`outputSchema`) plus a text summary. |
| `qa_inspect_element` | Root-cause one element: box, clip chain, reachable region, layer, hit-test samples, candidate findings. |
| `qa_get_evidence` | A finding from a previous run with its annotated, raw or full-page screenshot. |
| `qa_list_checks` | Checks, thresholds, suppression rules, defaults, current target policy. |
| `ui_login` | Register a role (login URL, steps, success checks) and sign in: `scripted` (secrets only as `${env:VAR}`) or `manual` (visible browser; a human handles CAPTCHA/MFA). |
| `ui_open` / `ui_observe` / `ui_act` / `ui_close` | Live session: open (safe or approved-writes), observe controls/forms/overlays, perform one verified action, close and summarise with evidence. |
| `ui_run_workflow` | Multi-step workflow with per-step verification, stop-on-failure, not-run disclosure, optional layout analysis per step. |
| `ui_explore` | Budgeted read-only exploration building a state graph; reports tested vs untested actions with reasons and issues. |

Example `ui_act` arguments (verified write in an approved session):

```json
{ "sessionId": "ui-…", "action": { "type": "click", "target": { "role": "button", "name": "Create project" } },
  "write": true, "expect": [{ "type": "url", "matches": "/projects/\\d+$" }, { "type": "alert", "contains": "Project created" }] }
```

Example call arguments:

```json
{ "url": "http://localhost:3000/settings", "zoomLevels": [1, 2],
  "actions": [{ "type": "click", "selector": "#sort-button" }], "includeImages": 2 }
```

### Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `QA_MCP_ALLOWED_ORIGINS` | *(empty: loopback + file only)* | Comma-separated origins, `https://*.example.com` wildcards, or `*` |
| `QA_MCP_ALLOW_FILE` | `1` | Set `0` to refuse `file:` URLs |
| `QA_MCP_ARTIFACTS_DIR` | `<os tmp>/universal-qa-mcp/runs` | Where screenshots and `report.json` / `report.md` are written |
| `QA_MCP_BROWSER_CHANNEL` | *(bundled Chromium)* | e.g. `chrome`, `msedge` |
| `QA_MCP_HEADED` | `0` | `1` to watch the browser |
| `QA_MCP_WRITE_ORIGINS` | *(empty)* | Non-loopback origins where approved writes are allowed |
| `QA_MCP_UPLOAD_DIRS` | *(empty: uploads refused)* | Directories files may be uploaded from (`;` or `,` separated) |
| `QA_MCP_SESSIONS_DIR` | `<os tmp>/universal-qa-mcp/sessions` | Role definitions and saved sessions (cookies — keep private) |

### Safety

- Only loopback and `file:` targets unless an origin is explicitly authorised.
- Audits are read-only: they navigate, measure and screenshot. Verification probes (temporary inline styles,
  focus, scrolling) are reverted immediately.
- Setup actions on non-loopback targets refuse submit buttons and destructive-looking labels
  (delete, pay, checkout, unsubscribe, publish, deploy, …) unless `allowDestructiveActions` is set.
- Setup actions that navigate to a non-authorised URL abort the configuration (reported as `blocked`).
- Operator sessions are safe by default: write actions are refused and non-GET requests are aborted by a network
  guard. Writes need an approved-writes session, an approval record and `write: true` per action. CAPTCHA, MFA,
  HTTP 401/403/429 and expired sessions stop the session for a human; challenges are never automated or bypassed.
- Evidence (screenshots, JSONL event logs, Playwright traces) is redacted for `${env:…}` secrets, but traces of
  authenticated sessions contain session cookies: keep artifact directories private.

## CLI

```bash
node scripts/serve-fixtures.mjs                      # fixtures on http://127.0.0.1:4410/
node dist/cli.js http://127.0.0.1:4410/broken/nav.html --viewports 375x812,1280x800 --zoom 1,2 --out .qa-artifacts
```

## Fixtures

- `fixtures/broken/*.html` — deliberately broken UI (overlapping buttons, clipped navigation, overflowing
  dashboard cards, clipped/detached dropdowns, hidden and obstructed controls, inconsistent responsive layouts,
  a modal taller than the viewport, clipped text). Each defect is commented `DEFECT:`.
- `fixtures/clean/*.html` — valid but tricky layouts (fixed header, skip link, sr-only text, ellipsis,
  line-clamp, avatar stack, caption over image, badge on icon button, scrolling table, custom checkbox,
  shadow DOM, open dropdown/tooltip, carousel, collapsed accordion, scrolling modal with backdrop).

`data-defect` attributes exist only for the test oracle; `test/integrity.test.ts` asserts the engine never reads them.

- `test/sample-app/` — controlled application for the operator tests (two roles, dynamic forms, nested menus,
  tabs, delayed content, upload, drag and drop, popups, downloads, dialogs, checkout wizard, an obstructed control,
  a CAPTCHA page, a 403 page, and control endpoints for injected network failures and session expiry).
