# Universal QA MCP — architecture

## Goal

Find visible layout defects with **measurements**, not visual impressions. Every finding is derived from
DOM geometry captured in a real browser and, where physically possible, re-confirmed in the live page
(pixel differentials, hit tests, focus/scroll probes). A screenshot documents the state; it never establishes the defect or its CSS cause.

## Layers

```
MCP client (Claude Code)
   │  stdio, MCP TS SDK v2 (@modelcontextprotocol/server 2.4.0; serves 2025 "initialize" and 2026-07-28 eras)
src/server.ts ──────────── tools: qa_audit_layout · qa_inspect_element · qa_get_evidence · qa_list_checks
   │
src/safety/policy.ts ───── URL allow-list (loopback/file by default; QA_MCP_ALLOWED_ORIGINS for others)
src/browser/actions.ts ─── optional setup steps (click/hover/fill…); destructive-label & submit guard
src/browser/session.ts ─── one headless Chromium (Playwright 1.65), one isolated context per configuration,
   │                       zoom emulation (CSS viewport = window/zoom, DPR = zoom)
src/engine/audit.ts ────── for each configuration → runner; then cross-configuration aggregation + report
src/engine/runner.ts ───── navigate → settle → actions → collect → detect → consolidate → verify → evidence
   │
   ├── src/inpage/collector.js   (runs in the page; read-only except reversible verifier probes)
   │     • walks the flat tree incl. open shadow roots; per element: border box, client/clip box,
   │       computed styles, scroll metrics, text line boxes (Range.getClientRects), flags
   │       (interactive, focusable, aria-hidden, inert, sr-only, popup/modal/top-layer, fixed-CB…)
   │     • hit tests (elementFromPoint, shadow-piercing) at 3×3 points per control, at scroll 0 and
   │       again after scrollIntoView({block:'center'}) when needed; text-line occlusion probes with the
   │       window stepped one viewport at a time; every scroll offset restored afterwards
   │     • verifier API: remeasure, reveal, stackAt, override/restore (temporary !important styles),
   │       focusProbe, reachProbe, maxScrollX
   ├── src/engine/model.ts        SnapshotModel: tree relations, containing-block-aware clip chains,
   │                              visible rect, hidden-only clip region, reachable scroll region, layers
   ├── src/engine/detectors/*     pure functions SnapshotModel → Candidate[] (unit-testable, no browser)
   ├── src/engine/consolidate.ts  merges symptoms of one root cause; post-verification merges
   ├── src/engine/verify.ts       live re-confirmation + status/confidence decision + evidence capture
   └── src/evidence/png.ts        pixel diff and role-coloured annotation (pngjs)
src/report/schema.ts ───── zod schema = TS types = MCP outputSchema (single source of truth)
```

## Why the clip model is containing-block aware

`overflow: hidden` only clips descendants whose containing-block chain passes through it. A dropdown
positioned against an ancestor *outside* an `overflow:hidden` panel escapes it; a `position:fixed` element
escapes everything except ancestors with `transform`/`filter`/`contain`/`will-change` (which become its
containing block); top-layer elements (modal `<dialog>`, open popovers) escape all clipping. Getting this wrong
is the main source of false "clipped dropdown" reports, so it is modelled explicitly (`SnapshotModel.clipInfo`)
and unit-tested.

## Checks (Phase 1)

| Category | Measured condition | Live verification |
|---|---|---|
| overlap (pairs) | glyph-ink rects / control boxes / media of unrelated elements intersect ≥ 3px | hide each element in turn; each must paint inside the intersection with the other hidden (handles occlusion) |
| overlap (occlusion) | hit tests along text lines return an unrelated element | recolour the text: invisible now, visible once the occluding subtree is hidden |
| text-clipping | text line boxes cut by an `overflow:hidden/clip` box (own or ancestor) | `overflow:visible` + magenta text; pixels must appear in the clipped-away region with no layout shift |
| viewport-overflow | `scrollWidth > clientWidth`; culprits = elements escaping their parent | `window.scrollTo` actually scrolls horizontally |
| container-overflow | in-flow content outside a non-clipping container's border box | hiding the spilled element changes pixels outside the container |
| offscreen-target | control outside the reachable region (doc origin, clipped root, fixed layer, scroller negative overflow) | focus probe (skip-link pattern suppressed only if it appears **without** scrolling) |
| obstructed-target | hit tests inside the control's visible area hit an unrelated element | re-hit-test at the same scroll; hide the obstructor to classify visible vs invisible blocker |
| clipped-target | control partly/fully cut by an `overflow:hidden` ancestor | as text-clipping |
| popup-clipping | open menu/listbox/tooltip/popover/dialog cut by an ancestor, or a fixed dialog past the viewport | unclip diff; or scroll everything to the end and re-measure |
| popup-placement | open non-modal popup > 48px from its trigger (aria-controls, popovertarget, aria-labelledby) | stable re-measurement |
| misalignment | 1–2 of ≥ 3 same-kind siblings 2–16px off the shared top/centre/bottom (or left/centre/right) line | stable re-measurement; capped at *potential* |
| inconsistent-spacing | in ≥ 4 same-kind siblings, 1–2 gaps differ by ≥ max(4px, 25%) | capped at *potential* |
| responsive-layout | controls visible at the widest configuration are not rendered at a narrower one, with no disclosure control | capped at *potential*; every other finding is also annotated with the configurations it reproduces in |

### Statuses

- **verified** — measured and re-confirmed in the live page. Where no pixel/interaction check is physically
  possible (e.g. the clipped region lies outside the viewport) the finding says so explicitly and confidence is capped at 0.8.
- **potential** — measured anomaly whose defect-ness depends on design intent, or that could not be re-confirmed
  (layout moved between measurements, visual check inconclusive, verification budget exhausted).
- **blocked** — the check could not run (navigation/policy/collection failure, element detached).

### False-positive guards (reported under `suppressed`, never silently dropped)

intentional-overlay (open popup/modal/top layer) · covered-by-open-modal (incl. full-viewport backdrops) ·
covered-by-open-popup · permitted-truncation (ellipsis, line-clamp) · reachable-on-focus (skip links) ·
intentional-stack (consistent negative-margin stacks) · overlay-on-media (captions/controls inside media) ·
fixed-or-sticky-media · collapsed-container (closed accordions) · carousel-viewport · hidden-content
(aria-hidden/inert) · disclosure-present (responsive nav with a menu button) · no-visible-change (pixel check
proved nothing visible collides) · scroll containers (content reachable by scrolling is never "clipped").

## Extension plan

Implemented since Phase 1 — see [OPERATOR.md](OPERATOR.md): **browser operator** (verified actions, isolated role
sessions, safety model), **application exploration** (state graph, `src/explore/`) and **workflow testing**
(`src/functional/`). Both can run this layout engine on any live state via `analyzePage`.

Still planned — later phases add collectors, detectors and auditors without touching the existing ones:

| Phase | Plugs in as | Reuses |
|---|---|---|
| Element inventory | a report section built from operator observations + `SnapshotModel` (controls, names, roles, selectors) | observer, collector |
| Forms & validation | an invalid-input generator for the explorer's form strategy, run in approved-writes sessions on loopback/allow-listed apps | operator, expectations |
| Accessibility | detectors over the same snapshot (target size, focus visibility, contrast via pixel sampling) plus axe-core as a cross-check | collector, png |
| Network & console | already captured per configuration in `diagnostics`; promote to findings with severity rules | runner |
| Visual regression | store per-configuration full-page + per-finding crops; diff with `diffCount` against a baseline run | evidence |
| UX enhancement suggestions | a separate, clearly-labelled *suggestion* channel; never mixed with defects | report |
| Coverage gaps | `coverage` section already lists what was not inspected (iframes, closed shadow roots, caps) | report |

## Known limitations

- iframe contents and closed shadow roots are not inspected (counted in `coverage`).
- `::before/::after` pseudo-elements are not separate measurement subjects (their hit-testing is attributed to the host element).
- Headless Chromium hides scrollbars, so scrollbar-width effects (e.g. `100vw` overflow) do not reproduce.
- Zoom is emulated through the CSS viewport and devicePixelRatio, not the browser UI zoom path.
- Only the loaded state plus caller-supplied actions is inspected; hover/focus/open states are not explored automatically yet.
- Transformed (rotated/scaled) clip boxes are approximated by their axis-aligned bounding boxes.
- Interactive detection is semantic HTML/ARIA plus a `cursor:pointer` heuristic; JS click handlers on plain elements are not introspected.
