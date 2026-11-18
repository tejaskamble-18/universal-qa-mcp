import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { type Action, ActionPolicyError, runActions } from '../browser/actions.js';
import { type BrowserManager, type ConfigRequest } from '../browser/session.js';
import type {
  Blocked,
  CategoryT,
  ElementRef,
  ElementRoleT,
  Evidence,
  RunConfigInfo,
  SeverityT,
  StatusT,
  Suppressed,
} from '../report/schema.js';
import { checkUrl, type TargetPolicy } from '../safety/policy.js';
import { type Candidate, DEFAULT_THRESHOLDS, type Thresholds } from './candidate.js';
import { consolidate, mergeObstructions } from './consolidate.js';
import { selectDetectors } from './detectors/index.js';
import { roundRect } from './geometry.js';
import { SnapshotModel } from './model.js';
import type { CollectOptions, PageSnapshot, UnrenderedControl } from './snapshot-types.js';
import { verifyCandidates } from './verify.js';

let collectorSource: string | null = null;
export function loadCollectorSource(): string {
  collectorSource ??= readFileSync(new URL('../inpage/collector.js', import.meta.url), 'utf8');
  return collectorSource;
}

export interface ConfigFinding {
  configKey: string;
  category: CategoryT;
  key: string;
  title: string;
  description: string;
  status: StatusT;
  severity: SeverityT;
  confidence: number;
  elements: ElementRef[];
  measurements: Record<string, unknown>;
  evidence: Evidence;
  consoleCheck: string;
  notes: string[];
  relatedKeys: { key: string; relation: string }[];
}

export interface ConfigResult {
  info: RunConfigInfo | null;
  request: ConfigRequest;
  findings: ConfigFinding[];
  suppressed: Suppressed[];
  blocked: Blocked[];
  stats: PageSnapshot['stats'] | null;
  controls: { visible: ElementRef[]; unrendered: UnrenderedControl[]; disclosure: string[] } | null;
  fullPageScreenshot: string | null;
  httpStatus: number | null;
  budgetExceeded: boolean;
  consoleErrors: string[];
  failedRequests: string[];
  pageTitle: string;
}

export interface ConfigRunOptions {
  url: string;
  policy: TargetPolicy;
  actions: readonly Action[];
  allowDestructiveActions: boolean;
  checks?: readonly CategoryT[];
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  settleMs: number;
  timeoutMs: number;
  thresholds: Thresholds;
  collect: CollectOptions;
  maxVerifyPerConfig: number;
  /** Run directory, or null to skip writing screenshots. */
  runDir: string | null;
}

const STYLE_KEYS = ['display', 'position', 'zIndex', 'overflowX', 'overflowY', 'width', 'height', 'maxHeight', 'opacity', 'pointerEvents', 'textOverflow', 'whiteSpace'] as const;

export function elementRef(model: SnapshotModel, i: number, role: ElementRoleT): ElementRef {
  const e = model.el(i);
  const styles: Record<string, string | number | boolean> = {};
  for (const k of STYLE_KEYS) styles[k] = e.style[k];
  styles.margin = e.style.margin.join(' ');
  const vis = model.visibleRect(i);
  return {
    role,
    selector: e.selector,
    tag: e.tag,
    id: e.id,
    classes: e.classes,
    ariaRole: e.role,
    name: e.name,
    text: e.textSnippet,
    rect: roundRect(e.rect),
    visibleRect: vis ? roundRect(vis) : null,
    styles,
  };
}

async function settle(page: Page, ms: number): Promise<void> {
  await page
    .evaluate(async () => {
      if (document.fonts) await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    })
    .catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
  if (ms > 0) await page.waitForTimeout(ms);
}

export async function collectSnapshot(page: Page, opts: CollectOptions): Promise<PageSnapshot> {
  await page.evaluate(loadCollectorSource());
  return (await page.evaluate((o) => (window as any).__uqa.collect(o), opts)) as PageSnapshot;
}

/** Navigate, run setup actions and settle. Throws on navigation/policy failure. */
export async function preparePage(
  page: Page,
  opts: Pick<ConfigRunOptions, 'url' | 'policy' | 'actions' | 'allowDestructiveActions' | 'waitUntil' | 'settleMs' | 'timeoutMs'>,
): Promise<{ httpStatus: number | null }> {
  const pol = checkUrl(opts.url, opts.policy);
  if (!pol.ok) throw new ActionPolicyError(pol.reason);
  const resp = await page.goto(opts.url, { waitUntil: opts.waitUntil, timeout: opts.timeoutMs });
  await settle(page, opts.settleMs);
  if (opts.actions.length) {
    await runActions(page, opts.actions, { loopback: pol.loopback, allowDestructive: opts.allowDestructiveActions, timeoutMs: opts.timeoutMs });
    await settle(page, opts.settleMs);
    const after = checkUrl(page.url(), opts.policy);
    if (!after.ok) throw new ActionPolicyError(`Setup actions navigated to a non-authorised URL: ${page.url()}`);
  }
  return { httpStatus: resp ? resp.status() : null };
}

function toConfigFinding(model: SnapshotModel, info: RunConfigInfo, c: Candidate, v: { status: StatusT; severity: SeverityT; confidence: number; evidence: Evidence; notes: string[] }): ConfigFinding {
  return {
    configKey: info.key,
    category: c.category,
    key: c.key,
    title: c.title,
    description: c.description,
    status: v.status,
    severity: v.severity,
    confidence: v.confidence,
    elements: c.elements.map((e) => elementRef(model, e.index, e.role)),
    measurements: c.measurements,
    evidence: v.evidence,
    consoleCheck: c.consoleCheck,
    notes: [...new Set([...c.notes, ...v.notes])],
    relatedKeys: c.related ?? [],
  };
}

function suppressedEntry(model: SnapshotModel, info: RunConfigInfo, c: Candidate, s: NonNullable<Candidate['suppressed']>): Suppressed {
  return {
    category: c.category,
    rule: s.rule,
    reason: s.reason,
    configKey: info.key,
    selectors: c.elements.map((e) => model.el(e.index).selector),
  };
}

export async function runConfig(browsers: BrowserManager, request: ConfigRequest, opts: ConfigRunOptions): Promise<ConfigResult> {
  const result: ConfigResult = {
    info: null,
    request,
    findings: [],
    suppressed: [],
    blocked: [],
    stats: null,
    controls: null,
    fullPageScreenshot: null,
    httpStatus: null,
    budgetExceeded: false,
    consoleErrors: [],
    failedRequests: [],
    pageTitle: '',
  };
  let context;
  try {
    const created = await browsers.newContext(request);
    context = created.context;
    result.info = created.info;
  } catch (err) {
    result.blocked.push({ configKey: null, stage: 'browser', reason: 'Could not start the browser context', detail: (err as Error).message });
    return result;
  }
  const info = result.info;
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && result.consoleErrors.length < 50) result.consoleErrors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => {
    if (result.consoleErrors.length < 50) result.consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`);
  });
  page.on('requestfailed', (r) => {
    if (result.failedRequests.length < 50) result.failedRequests.push(`${r.failure()?.errorText ?? 'failed'} ${r.url().slice(0, 200)}`);
  });
  try {
    try {
      const prep = await preparePage(page, opts);
      result.httpStatus = prep.httpStatus;
      if (prep.httpStatus !== null && prep.httpStatus >= 400) {
        result.blocked.push({
          configKey: info.key,
          stage: 'navigation',
          reason: `HTTP ${prep.httpStatus}`,
          detail: 'The page responded with an error status; inspected the error page as rendered.',
        });
      }
    } catch (err) {
      const stage = err instanceof ActionPolicyError ? 'policy' : 'navigation/actions';
      result.blocked.push({ configKey: info.key, stage, reason: 'Page could not be prepared for inspection', detail: (err as Error).message.split('\n')[0] ?? '' });
      return result;
    }
    result.pageTitle = await page.title();
    const evidenceDir = opts.runDir ? join(opts.runDir, info.key) : null;
    const a = await analyzePage(page, info, { ...opts, evidenceDir });
    Object.assign(result, {
      findings: a.findings,
      stats: a.stats,
      controls: a.controls,
      budgetExceeded: a.budgetExceeded,
      fullPageScreenshot: a.fullPageScreenshot,
    });
    result.suppressed.push(...a.suppressed);
    result.blocked.push(...a.blocked);
    return result;
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Default-option UI quality analysis of a live page (used by workflows and exploration). */
export function analyzeLivePage(page: Page, info: RunConfigInfo, evidenceDir: string | null): Promise<AnalysisResult> {
  return analyzePage(page, info, { thresholds: DEFAULT_THRESHOLDS, collect: LIVE_COLLECT, maxVerifyPerConfig: 20, evidenceDir });
}

const LIVE_COLLECT: CollectOptions = {
  maxElements: 8000,
  maxHitElements: 1500,
  maxScrolledProbes: 300,
  maxTextProbeElements: 3000,
  maxTextScrollSteps: 12,
  ignoreSelectors: [],
};

export interface AnalysisResult {
  findings: ConfigFinding[];
  suppressed: Suppressed[];
  blocked: Blocked[];
  stats: PageSnapshot['stats'] | null;
  controls: ConfigResult['controls'];
  budgetExceeded: boolean;
  fullPageScreenshot: string | null;
}

/**
 * UI quality analysis of the page exactly as it is now (no navigation):
 * collect → detect → consolidate → verify → evidence. Used by the layout audit
 * for each configuration and by the browser operator for workflow steps and
 * explored states. Verification probes are reverted; the window is left at scroll (0,0).
 */
export async function analyzePage(
  page: Page,
  info: RunConfigInfo,
  opts: Pick<ConfigRunOptions, 'checks' | 'thresholds' | 'collect' | 'maxVerifyPerConfig'> & { evidenceDir: string | null },
): Promise<AnalysisResult> {
  const out: AnalysisResult = { findings: [], suppressed: [], blocked: [], stats: null, controls: null, budgetExceeded: false, fullPageScreenshot: null };
  let snap: PageSnapshot;
  try {
    snap = await collectSnapshot(page, opts.collect);
  } catch (err) {
    out.blocked.push({ configKey: info.key, stage: 'collect', reason: 'DOM geometry collection failed', detail: (err as Error).message.split('\n')[0] ?? '' });
    return out;
  }
  out.stats = snap.stats;
  const model = new SnapshotModel(snap);
  out.controls = {
    visible: model
      .where((e) => e.flags.interactive && e.flags.interactiveSource === 'semantic' && e.flags.visible && !e.flags.ariaHidden && !e.flags.srOnly)
      .map((i) => elementRef(model, i, 'subject')),
    unrendered: snap.unrenderedControls,
    disclosure: snap.disclosureControls,
  };

  const ctx = { model, t: opts.thresholds };
  const raw = selectDetectors(opts.checks).flatMap((d) => d.run(ctx));
  const merged = consolidate(model, raw);
  for (const c of merged) if (c.suppressed) out.suppressed.push(suppressedEntry(model, info, c, c.suppressed));
  const live = merged.filter((c) => !c.suppressed && c.elements.length);

  const { results, budgetExceeded } = await verifyCandidates(
    { page, model, t: opts.thresholds, configKey: info.key, evidenceDir: opts.evidenceDir, budget: opts.maxVerifyPerConfig },
    live,
  );
  out.budgetExceeded = budgetExceeded;
  for (const v of mergeObstructions(model, results)) {
    if (v.suppressed) out.suppressed.push(suppressedEntry(model, info, v.cand, v.suppressed));
    else out.findings.push(toConfigFinding(model, info, v.cand, v));
  }

  if (opts.evidenceDir) {
    try {
      mkdirSync(opts.evidenceDir, { recursive: true });
      const path = join(opts.evidenceDir, 'full-page.png');
      const tall = snap.doc.scrollHeight > 12000;
      const buf = await page.screenshot({
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        ...(tall ? { clip: { x: 0, y: 0, width: Math.max(1, snap.doc.scrollWidth), height: 12000 } } : {}),
      });
      writeFileSync(path, buf);
      out.fullPageScreenshot = path;
    } catch (err) {
      out.blocked.push({ configKey: info.key, stage: 'screenshot', reason: 'Full-page screenshot failed', detail: (err as Error).message.split('\n')[0] ?? '' });
    }
  }
  return out;
}
