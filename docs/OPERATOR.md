# Adaptive browser interaction engine (browser operator)

Performs legitimate user workflows on authorised web apps, verifies every
meaningful action, and reports blocked, incomplete and untested work honestly.

## Layers (separated as required)

| Layer | Code | Responsibility | Depends on |
|---|---|---|---|
| Browser control | `src/operator/` | Isolated role sessions, actions, settling, observation, safety, evidence | `functional/expectations` (leaf) |
| Application exploration | `src/explore/` | State graph, planning from live observations, safe budgeted exploration | operator, engine |
| Functional verification | `src/functional/` | Expectation engine, intrinsic outcomes, workflow runner, disclosures | operator, engine |
| UI quality analysis | `src/engine/` | Layout engine; `analyzePage` runs on any live page/state | — |

## Action pipeline (`Operator.act`)

1. **Resolve** the target (role/label/text/test-id/CSS/observation ref, optionally inside an iframe or container).
   Missing or ambiguous targets are `blocked` with candidates listed — never guessed.
2. **Classify**: `read` (navigation, menus, tabs, disclosures, scrolling), `local` (field edits, uploads, drags),
   `write` (form submit, write-verb labels, switches, sign-out; destructive link labels).
3. **Policy**: unauthorised URLs, uploads outside `QA_MCP_UPLOAD_DIRS`, CAPTCHA frames → `refused`;
   a write must be declared (`write: true`) in an `approved-writes` session; a write already performed in
   the session (same path + control + form values, or explicit `idempotencyKey`) → `duplicate-prevented`.
4. **Execute** with Playwright actionability checks — never `force`, so an element a user cannot click is not "clicked".
5. **Settle**: no in-flight requests (responses count as done) and no DOM mutations for 250 ms, bounded (6 s).
6. **Observe**: controls, forms, open overlays, live-region messages, headings, focus, challenge signals, fingerprint.
7. **Challenges**: CAPTCHA / MFA / HTTP 401-403-429 / expired session ⇒ `needs-operator`; the session halts and
   later actions are not executed. Expired sessions can be re-authenticated by the role's scripted login
   (`reauth: "scripted"`) — only when the interrupted action is safe to repeat.
8. **Verify** explicit expectations plus the intrinsic outcome of the control (filled value, selected option,
   checked state, selected tab, expanded disclosure, link destination, popup for `target=_blank`, download,
   uploaded file names). Polling covers asynchronous UIs.
9. **Retry** only when safe and bounded (≤ 3 retries): transient actionability failures when no write was sent;
   failed checks for idempotent reads, or for non-toggle controls whose attempt issued only GETs that failed.
   Writes whose request was sent are **never** retried.
10. **Evidence**: before/after screenshots, visual-change pixel count, request/console/dialog/popup/download log
    (JSONL), Playwright trace per session, `actions.json` (redacted).

### Statuses

`passed` (expected outcome observed) · `performed` (ran, something changed, nothing to verify — not a success) ·
`no-effect` · `failed` · `blocked` (intercepted — the interceptor is named —, hidden, disabled, missing, ambiguous) ·
`refused` · `duplicate-prevented` · `outcome-unknown` (write sent, response lost/5xx; not retried) · `needs-operator`.

## Safety model

- Targets: loopback/file by default; other origins only via `QA_MCP_ALLOWED_ORIGINS`. Main-frame navigation to
  non-authorised origins is aborted at the network layer.
- Safe mode (default): write actions are refused **and** every non-GET request is aborted by a network guard, so
  a write hidden behind a read-looking control is stopped and reported (`guard-blocked-write`).
- Approved writes: mode `approved-writes` + `{ approvedBy, reason }`; non-loopback origins additionally need
  `QA_MCP_WRITE_ORIGINS`. Identical write requests within one action are blocked as duplicates.
- Sessions: one storage-state file per role, loaded only into that role's contexts. Logins run in a separate,
  untraced context; secrets come only from `${env:VAR}` references (literal secrets in login scripts are rejected)
  and are redacted from every log. Traces of authenticated sessions still contain session cookies — keep the
  artifacts directory private.
- Bot protection: no stealth flags, no fingerprint spoofing, no CAPTCHA solving or challenge-frame interaction.
  Challenges stop the session; `ui_login` with `method: "manual"` opens a visible browser for a human.
  Exploration stops entirely on blocked access / rate limiting.

## Exploration

States are abstract UI fingerprints (route, visible control signatures, open overlays, toggled controls, headings).
Each new state's actions are planned from its observation: links in scope, menus, tabs, disclosures, read-only
buttons, and each form filled with valid sample values (never submitted). Writes, toggles, file inputs and
drag-only items are listed as untested with reasons; repeated items are sampled; controls already explored from
another state (header navigation, global menus) are not re-tested. States are re-reached by a fresh load of the
start URL plus replay of their path. Every discovered action ends in exactly one of: `tested`, `skipped-unsafe`,
`skipped-out-of-scope`, `skipped-similar`, `skipped-depth`, `skipped-budget`, `unreachable`, `halted`.

## Acceptance environment

`test/sample-app/` — a controlled SPA + JSON API with two roles, dynamic forms, nested menus, keyboard tabs,
delayed content, infinite scroll, upload, drag and drop, popups, downloads, confirm dialogs, a multi-step checkout,
a disguised write, an obstructed control, misaligned cards, a CAPTCHA page, a 403 page, and control endpoints to
inject failures (`status-500`, `abort`, `delay`, `process-then-502`) and expire sessions.

## Known limitations

- Exploration replays paths from the start URL; states that depend on server-side changes made outside the run,
  or on time, may become `unreachable` (reported).
- State identity is heuristic (fingerprints); very dynamic pages can produce more states than a human would count.
- Global-chrome de-duplication assumes a control with the same role/name (or link destination) behaves the same on
  every page.
- Write classification is label/semantics based; the network guard is the safety net for unclassified writes, but an
  app that writes via GET (or WebSocket messages) is not stopped by the guard.
- iframes are reachable via `target.frame`, but observation and exploration cover the main frame only.
- Manual (operator) login needs a desktop session to show the browser window.
