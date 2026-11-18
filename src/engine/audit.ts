import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Action, describeAction } from '../browser/actions.js';
import { type BrowserManager, type ConfigRequest } from '../browser/session.js';
import { formatMarkdown } from '../report/format.js';
import {
  CATEGORIES,
  type CategoryT,
  type ElementRef,
  type Finding,
  type Report,
  type RunConfigInfo,
  SEVERITY_RANK,
  STATUS_RANK,
  type Suppressed,
} from '../report/schema.js';
import type { TargetPolicy } from '../safety/policy.js';
import { DEFAULT_THRESHOLDS, type Thresholds } from './candidate.js';
import { type ConfigFinding, type ConfigResult, runConfig } from './runner.js';
import type { CollectOptions } from './snapshot-types.js';

export const TOOL_NAME = 'universal-qa-mcp';
export const TOOL_VERSION = '0.1.0';

export const DEFAULT_CONFIGS: ConfigRequest[] = [
  { width: 375, height: 812, zoom: 1, colorScheme: 'light' },
  { width: 768, height: 1024, zoom: 1, colorScheme: 'light' },
  { width: 1280, height: 800, zoom: 1, colorScheme: 'light' },
];

export const DEFAULT_COLLECT: CollectOptions = {
  maxElements: 8000,
  maxHitElements: 1500,
  maxScrolledProbes: 300,
  maxTextProbeElements: 3000,
  maxTextScrollSteps: 12,
  ignoreSelectors: [],
};

export interface AuditOptions {
  url: string;
  configs: ConfigRequest[];
  actions: Action[];
  allowDestructiveActions: boolean;
  checks?: CategoryT[];
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  settleMs: number;
  timeoutMs: number;
  thresholds?: Partial<Thresholds>;
  ignoreSelectors: string[];
  maxVerifyPerConfig: number;
  /** Base directory for run artifacts; null disables screenshots and report files. */
  artifactsRoot: string | null;
  policy: TargetPolicy;
  log?: (msg: string) => void;
}

const LIMITATIONS = [
  'iframe contents are not inspected (the iframe element itself is).',
  'Closed shadow roots cannot be inspected; open shadow roots are.',
  '::before/::after pseudo-elements are not measured as separate elements.',
  'Canvas/WebGL/video content is treated as an opaque box.',
  'Headless Chromium hides scrollbars, so scrollbar-width effects (e.g. width:100vw overflow) are not reproduced.',
  'Only the loaded state plus the supplied setup actions is inspected; other hover/focus/open states are not explored.',
  'Misalignment and inconsistent-spacing findings are heuristics and are capped at "potential".',
  'prefers-reduced-motion: reduce is emulated for measurement stability.',
];

const shortHash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 10);

function better(a: ConfigFinding, b: ConfigFinding): boolean {
  if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) return STATUS_RANK[a.status] > STATUS_RANK[b.status];
  if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) return SEVERITY_RANK[a.severity] > SEVERITY_RANK[b.severity];
  return a.confidence > b.confidence;
}

function confidenceLabel(c: number): 'high' | 'medium' | 'low' {
  return c >= 0.8 ? 'high' : c >= 0.6 ? 'medium' : 'low';
}

function reproSteps(o: AuditOptions, info: RunConfigInfo, f: ConfigFinding): string[] {
  const zoomed = info.zoom !== 1;
  const steps = [
    `Open Chromium ${info.browserVersion} with a ${info.viewport.width}×${info.viewport.height} window` +
      (zoomed
        ? ` at ${Math.round(info.zoom * 100)}% zoom (emulated: CSS viewport ${info.cssViewport.width}×${info.cssViewport.height}, devicePixelRatio ${info.deviceScaleFactor})`
        : '') +
      `${info.colorScheme === 'dark' ? ', prefers-color-scheme: dark' : ''}, prefers-reduced-motion: reduce.`,
    `Navigate to ${o.url}; wait for '${o.waitUntil}', web fonts, network idle and ${o.settleMs}ms.`,
    ...o.actions.map(describeAction),
    'Scroll the window to (0, 0).',
  ];
  if (f.category === 'obstructed-target') steps.push('Scroll the affected control into the centre of the viewport and click it.');
  steps.push(`Observe: ${f.description}`);
  return steps;
}

function buildFindings(o: AuditOptions, results: ConfigResult[]): Finding[] {
  const completed = results.filter((r) => r.info && r.stats).map((r) => r.info!);
  const infoByKey = new Map(completed.map((i) => [i.key, i]));
  const fullPage = new Map(results.filter((r) => r.info).map((r) => [r.info!.key, r.fullPageScreenshot]));
  const groups = new Map<string, ConfigFinding[]>();
  for (const r of results) for (const f of r.findings) groups.set(f.key, [...(groups.get(f.key) ?? []), f]);

  const idOf = (key: string): string => `F-${shortHash(key)}`;
  const findings: Finding[] = [];
  for (const [key, occ] of groups) {
    const primary = occ.reduce((a, b) => (better(b, a) ? b : a));
    const info = infoByKey.get(primary.configKey)!;
    const failing = occ.map((x) => x.configKey);
    const passing = completed.map((i) => i.key).filter((k) => !failing.includes(k));
    const severity = occ.reduce((s, x) => (SEVERITY_RANK[x.severity] > SEVERITY_RANK[s] ? x.severity : s), primary.severity);
    const label = (k: string): string => infoByKey.get(k)?.label ?? k;
    findings.push({
      id: idOf(key),
      category: primary.category,
      title: primary.title,
      description: primary.description,
      status: primary.status,
      severity,
      confidence: primary.confidence,
      confidenceLabel: confidenceLabel(primary.confidence),
      page: { url: o.url, title: results.find((r) => r.info?.key === primary.configKey)?.pageTitle ?? '' },
      config: info,
      elements: primary.elements,
      measurements: primary.measurements,
      evidence: { ...primary.evidence, fullPageScreenshot: fullPage.get(primary.configKey) ?? null },
      reproduction: { steps: reproSteps(o, info, primary), consoleCheck: primary.consoleCheck },
      occurrences: occ.map((x) => ({
        configKey: x.configKey,
        status: x.status,
        severity: x.severity,
        confidence: x.confidence,
        measurements: x.measurements,
        screenshot: x.evidence.screenshot,
      })),
      responsive:
        completed.length > 1 && passing.length
          ? {
              failingConfigs: failing,
              passingConfigs: passing,
              note: `Reproduces at ${failing.map(label).join(', ')}; not at ${passing.map(label).join(', ')}.`,
            }
          : null,
      related: [],
      notes: [...new Set(occ.flatMap((x) => x.notes))],
    });
  }
  // Resolve candidate-key relations to finding ids.
  const keyOfId = new Map([...groups.keys()].map((k) => [idOf(k), k]));
  for (const f of findings) {
    const occ = groups.get(keyOfId.get(f.id)!)!;
    const rel = new Map<string, string>();
    for (const x of occ) for (const r of x.relatedKeys) if (groups.has(r.key)) rel.set(idOf(r.key), r.relation);
    f.related = [...rel].map(([findingId, relation]) => ({ findingId, relation }));
  }
  return findings;
}

/** Controls visible at the widest configuration but not rendered at a narrower one. */
function responsiveFindings(o: AuditOptions, results: ConfigResult[], suppressed: Suppressed[]): Finding[] {
  const done = results.filter((r) => r.info && r.controls);
  if (done.length < 2) return [];
  const widest = done.reduce((a, b) => (b.info!.cssViewport.width > a.info!.cssViewport.width ? b : a));
  const occurrences: Finding['occurrences'] = [];
  let primary: { r: ConfigResult; missing: ElementRef[] } | null = null;
  for (const r of done) {
    if (r === widest || r.info!.cssViewport.width >= widest.info!.cssViewport.width) continue;
    const unrendered = new Set(r.controls!.unrendered.map((u) => u.selector));
    const missing = widest.controls!.visible.filter((c) => unrendered.has(c.selector));
    if (!missing.length) continue;
    if (r.controls!.disclosure.length) {
      suppressed.push({
        category: 'responsive-layout',
        rule: 'disclosure-present',
        reason: `${missing.length} control(s) visible at ${widest.info!.label} are hidden at ${r.info!.label}, but disclosure control(s) exist there (${r.controls!.disclosure.slice(0, 3).join(', ')}).`,
        configKey: r.info!.key,
        selectors: missing.slice(0, 10).map((m) => m.selector),
      });
      continue;
    }
    occurrences.push({
      configKey: r.info!.key,
      status: 'potential',
      severity: 'medium',
      confidence: 0.6,
      measurements: { missingCount: missing.length, missing: missing.slice(0, 20).map((m) => ({ selector: m.selector, name: m.name })), comparedWith: widest.info!.key },
      screenshot: r.fullPageScreenshot,
    });
    if (!primary || missing.length > primary.missing.length) primary = { r, missing };
  }
  if (!primary) return [];
  const info = primary.r.info!;
  const key = 'responsive-layout|missing-controls';
  return [
    {
      id: `F-${shortHash(key)}`,
      category: 'responsive-layout',
      title: 'Controls disappear at narrower viewports with no way to reach them',
      description:
        `${primary.missing.length} control(s) visible at ${widest.info!.label} are not rendered at ${info.label}, and no disclosure control ` +
        `(aria-expanded/aria-haspopup button, <summary>, popovertarget) is visible there: ` +
        primary.missing.slice(0, 5).map((m) => `${m.selector}${m.name ? ` ("${m.name.slice(0, 30)}")` : ''}`).join(', ') + '.',
      status: 'potential',
      severity: 'medium',
      confidence: 0.6,
      confidenceLabel: 'medium',
      page: { url: o.url, title: primary.r.pageTitle },
      config: info,
      elements: primary.missing.slice(0, 10),
      measurements: { missingCount: primary.missing.length, comparedWith: widest.info!.key },
      evidence: {
        screenshot: null,
        rawScreenshot: null,
        fullPageScreenshot: primary.r.fullPageScreenshot,
        visual: [],
        hitTests: [],
        stability: null,
        focusProbe: null,
        scrollProbe: null,
      },
      reproduction: {
        steps: [
          `Open Chromium ${info.browserVersion} with prefers-reduced-motion: reduce.`,
          `Navigate to ${o.url} at ${widest.info!.label} (CSS viewport ${widest.info!.cssViewport.width}×${widest.info!.cssViewport.height}); the listed controls are visible.`,
          ...o.actions.map(describeAction),
          `Open the same URL at ${info.label} (CSS viewport ${info.cssViewport.width}×${info.cssViewport.height}).`,
          'Observe: the listed controls are not rendered (display:none / hidden) and no menu toggle or other disclosure control is visible.',
        ],
        consoleCheck: `[${primary.missing.slice(0, 5).map((m) => JSON.stringify(m.selector)).join(', ')}].map(s => [s, getComputedStyle(document.querySelector(s)).display])`,
      },
      occurrences,
      responsive: {
        failingConfigs: occurrences.map((x) => x.configKey),
        passingConfigs: [widest.info!.key],
        note: 'Potential: the hidden controls may be intentionally desktop-only; confirm the narrow layout offers equivalent navigation.',
      },
      related: [],
      notes: [],
    },
  ];
}

function sortFindings(f: Finding[]): Finding[] {
  return f.sort(
    (a, b) =>
      STATUS_RANK[b.status] - STATUS_RANK[a.status] ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.confidence - a.confidence,
  );
}

export async function runAudit(browsers: BrowserManager, o: AuditOptions): Promise<Report> {
  const started = new Date();
  const runId = `run-${started.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
  const runDir = o.artifactsRoot ? resolve(o.artifactsRoot, runId) : null;
  if (runDir) mkdirSync(runDir, { recursive: true });
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(o.thresholds ?? {}) };
  const results: ConfigResult[] = [];
  for (const cfg of o.configs) {
    o.log?.(`auditing ${o.url} at ${cfg.width}x${cfg.height} zoom ${cfg.zoom}`);
    results.push(
      await runConfig(browsers, cfg, {
        url: o.url,
        policy: o.policy,
        actions: o.actions,
        allowDestructiveActions: o.allowDestructiveActions,
        checks: o.checks,
        waitUntil: o.waitUntil,
        settleMs: o.settleMs,
        timeoutMs: o.timeoutMs,
        thresholds,
        collect: { ...DEFAULT_COLLECT, ignoreSelectors: o.ignoreSelectors },
        maxVerifyPerConfig: o.maxVerifyPerConfig,
        runDir,
      }),
    );
  }

  const suppressed = results.flatMap((r) => r.suppressed);
  const runResponsive = !o.checks?.length || o.checks.includes('responsive-layout');
  const findings = sortFindings([
    ...buildFindings(o, results),
    ...(runResponsive ? responsiveFindings(o, results, suppressed) : []),
  ]);
  const blocked = results.flatMap((r) => r.blocked);
  const count = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
  const stats = results.map((r) => r.stats).filter((s) => !!s);
  const truncated = stats.some((s) => s.truncated);
  const iframes = Math.max(0, ...stats.map((s) => s.iframes));
  const limitations = [
    ...LIMITATIONS,
    ...(truncated ? [`Element cap (${DEFAULT_COLLECT.maxElements}) reached; later elements were not inspected.`] : []),
    ...(iframes ? [`${iframes} iframe(s) present whose contents were not inspected.`] : []),
  ];
  const finished = new Date();
  const report: Report = {
    runId,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    target: { url: o.url },
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    configs: results.map((r) => r.info).filter((i) => !!i),
    summary: {
      findings: findings.length,
      byStatus: count(findings.map((f) => f.status)),
      bySeverity: count(findings.map((f) => f.severity)),
      byCategory: count(findings.map((f) => f.category)),
      suppressed: suppressed.length,
      blocked: blocked.length,
    },
    findings,
    suppressed,
    blocked,
    coverage: {
      configsRequested: o.configs.length,
      configsCompleted: stats.length,
      checksRun: o.checks?.length ? o.checks : [...CATEGORIES],
      elementsRecorded: stats.reduce((s, x) => s + x.recorded, 0),
      interactiveHitProbed: stats.reduce((s, x) => s + x.hitProbedElements, 0),
      scrolledProbes: stats.reduce((s, x) => s + x.scrolledProbes, 0),
      truncated,
      iframesNotScanned: iframes,
      openShadowRoots: Math.max(0, ...stats.map((s) => s.openShadowRoots)),
      verificationBudgetExceeded: results.some((r) => r.budgetExceeded),
      limitations,
    },
    diagnostics: {
      httpStatus: Object.fromEntries(results.filter((r) => r.info).map((r) => [r.info!.key, r.httpStatus])),
      consoleErrors: [...new Set(results.flatMap((r) => r.consoleErrors))].slice(0, 50),
      failedRequests: [...new Set(results.flatMap((r) => r.failedRequests))].slice(0, 50),
    },
    artifactsDir: runDir,
    reportPath: runDir ? join(runDir, 'report.json') : null,
  };
  if (runDir) {
    writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(runDir, 'report.md'), formatMarkdown(report));
  }
  return report;
}
