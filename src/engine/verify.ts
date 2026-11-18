import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { PNG } from 'pngjs';
import { annotate, decode, diffCount, encode } from '../evidence/png.js';
import type {
  Evidence,
  SeverityT,
  StatusT,
  SuppressionRuleT,
  VisualCheck,
} from '../report/schema.js';
import { SEVERITY_RANK } from '../report/schema.js';
import type { Candidate, Thresholds, VerifyPlan } from './candidate.js';
import { intersect, pad, round2, roundRect, union } from './geometry.js';
import type { SnapshotModel } from './model.js';
import type { Rect } from './snapshot-types.js';

interface FocusResult {
  focused: boolean;
  before: Rect;
  after: Rect;
  windowScrolled: boolean;
  ancestorScrolled: boolean;
  inViewportFraction: number;
}

/** Typed wrappers over the in-page `window.__uqa` API. */
const api = {
  remeasure: (page: Page, indices: number[]) =>
    page.evaluate((i) => (window as any).__uqa.remeasure(i), indices) as Promise<{ rects: (Rect | null)[]; scrollX: number; scrollY: number }>,
  reveal: (page: Page, indices: number[]) =>
    page.evaluate((i) => (window as any).__uqa.reveal(i), indices) as Promise<{ rects: (Rect | null)[]; scrollX: number; scrollY: number }>,
  stackAt: (page: Page, x: number, y: number) =>
    page.evaluate(([px, py]) => (window as any).__uqa.stackAt(px, py), [x, y] as const) as Promise<number[]>,
  override: (page: Page, i: number, prop: string, value: string) =>
    page.evaluate(([a, b, c]) => (window as any).__uqa.override(a, b, c), [i, prop, value] as const) as Promise<boolean>,
  restore: (page: Page) => page.evaluate(() => (window as any).__uqa.restore()) as Promise<boolean>,
  focusProbe: (page: Page, i: number) =>
    page.evaluate((k) => (window as any).__uqa.focusProbe(k), i) as Promise<FocusResult | null>,
  maxScrollX: (page: Page) => page.evaluate(() => (window as any).__uqa.maxScrollX()) as Promise<number>,
  reachProbe: (page: Page, i: number) =>
    page.evaluate((k) => (window as any).__uqa.reachProbe(k), i) as Promise<{ rect: Rect; beyondBottom: number; beyondRight: number; windowScrollY: number } | null>,
  scrollTo: (page: Page, x: number, y: number) => page.evaluate(([a, b]) => window.scrollTo(a, b), [x, y] as const),
};

export interface VerifyContext {
  page: Page;
  model: SnapshotModel;
  t: Thresholds;
  configKey: string;
  /** Directory for this configuration's evidence images, or null to skip screenshots. */
  evidenceDir: string | null;
  budget: number;
}

export interface VerifiedCandidate {
  cand: Candidate;
  status: StatusT;
  severity: SeverityT;
  confidence: number;
  evidence: Evidence;
  notes: string[];
  suppressed?: { rule: SuppressionRuleT; reason: string };
}

interface Results {
  drift: number;
  visual: VisualCheck[];
  stackHasBoth?: boolean;
  coverReproduced?: boolean;
  focus?: FocusResult | null;
  maxScrollX?: number;
  reach?: { rect: Rect; beyondBottom: number; beyondRight: number; windowScrollY: number } | null;
  layoutShifted?: boolean;
  detached?: boolean;
  errors: string[];
  notes: string[];
}

function emptyEvidence(): Evidence {
  return { screenshot: null, rawScreenshot: null, fullPageScreenshot: null, visual: [], hitTests: [], stability: null, focusProbe: null, scrollProbe: null };
}

function viewportClip(r: Rect, model: SnapshotModel): Rect | null {
  const vp = model.viewport;
  const c = intersect(r, vp);
  if (!c) return null;
  const x = Math.max(0, Math.floor(c.x));
  const y = Math.max(0, Math.floor(c.y));
  const w = Math.min(vp.w - x, Math.ceil(c.x + c.w) - x);
  const h = Math.min(vp.h - y, Math.ceil(c.y + c.h) - y);
  return w >= 2 && h >= 2 ? { x, y, w, h } : null;
}

async function shot(page: Page, clip: Rect): Promise<PNG> {
  const buf = await page.screenshot({
    clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h },
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
    type: 'png',
  });
  return decode(buf);
}

/**
 * Pixel differential: capture `region` twice (baseline noise), apply each
 * mutation in turn (restoring between them) and count changed pixels.
 */
async function differential(
  page: Page,
  clip: Rect,
  t: Thresholds,
  mutations: { method: string; description: string; apply: () => Promise<unknown> }[],
): Promise<VisualCheck[]> {
  const base = await shot(page, clip);
  const base2 = await shot(page, clip);
  const noise = diffCount(base, base2, t.pixelDelta);
  const total = base.width * base.height;
  const out: VisualCheck[] = [];
  for (const m of mutations) {
    let changed = 0;
    try {
      await m.apply();
      changed = diffCount(base, await shot(page, clip), t.pixelDelta);
    } finally {
      await api.restore(page);
    }
    const conclusion: VisualCheck['conclusion'] =
      noise > total * 0.02 ? 'inconclusive' : changed - noise >= t.visualMinChangedPixels ? 'confirmed' : 'not-visible';
    out.push({
      method: m.method,
      description: m.description,
      region: roundRect(clip),
      changedPixels: changed,
      totalPixels: total,
      noisePixels: noise,
      conclusion,
      ...(conclusion === 'inconclusive' ? { note: 'Region changes between identical captures (animation/video); visual result not trusted.' } : {}),
    });
  }
  return out;
}

/** Capture `clip` in the base state and after each state change (restoring in between). */
async function captureStates(
  page: Page,
  clip: Rect,
  t: Thresholds,
  states: { name: string; apply: () => Promise<unknown> }[],
): Promise<{ base: PNG; noise: number; total: number; shots: Map<string, PNG> }> {
  const base = await shot(page, clip);
  const noise = diffCount(base, await shot(page, clip), t.pixelDelta);
  const shots = new Map<string, PNG>();
  for (const s of states) {
    try {
      await s.apply();
      shots.set(s.name, await shot(page, clip));
    } finally {
      await api.restore(page);
    }
  }
  return { base, noise, total: base.width * base.height, shots };
}

function translate(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
}

/**
 * Bring `anchor` into view and map a snapshot-space region (expressed relative
 * to the anchor's snapshot position) to the live viewport.
 */
async function locate(ctx: VerifyContext, anchor: number, region: Rect): Promise<Rect | null> {
  const live = await api.reveal(ctx.page, [anchor]);
  const lr = live.rects[0];
  if (!lr) return null;
  const sr = ctx.model.el(anchor).rect;
  return viewportClip(translate(region, lr.x - sr.x, lr.y - sr.y), ctx.model);
}

async function runPlan(ctx: VerifyContext, plan: VerifyPlan, res: Results): Promise<void> {
  const { page, model, t } = ctx;
  await api.scrollTo(page, 0, 0);
  switch (plan.kind) {
    case 'overlap': {
      const clip = await locate(ctx, plan.a, plan.region);
      if (!clip) {
        res.errors.push('overlap region is outside the viewport after scrolling');
        return;
      }
      const stack = await api.stackAt(page, clip.x + clip.w / 2, clip.y + clip.h / 2);
      const has = (i: number): boolean => stack.some((s) => s === i || model.isAncestor(i, s));
      res.stackHasBoth = has(plan.a) && has(plan.b);
      const hideA = () => api.override(page, plan.a, 'visibility', 'hidden');
      const hideB = () => api.override(page, plan.b, 'visibility', 'hidden');
      const cap = await captureStates(page, clip, t, [
        { name: 'noA', apply: hideA },
        { name: 'noB', apply: hideB },
        { name: 'none', apply: async () => (await hideA(), hideB()) },
      ]);
      const noA = cap.shots.get('noA')!;
      const noB = cap.shots.get('noB')!;
      const none = cap.shots.get('none')!;
      const sa = model.el(plan.a).selector;
      const sb = model.el(plan.b).selector;
      // Ink each element contributes to the intersection when the other one is absent.
      const inkA = diffCount(noB, none, t.pixelDelta);
      const inkB = diffCount(noA, none, t.pixelDelta);
      const verdict = (ink: number): VisualCheck['conclusion'] =>
        cap.noise > cap.total * 0.02 ? 'inconclusive' : ink - cap.noise >= t.visualMinChangedPixels ? 'confirmed' : 'not-visible';
      for (const [sel, other, ink] of [[sa, sb, inkA], [sb, sa, inkB]] as const) {
        const conclusion = verdict(ink);
        res.visual.push({
          method: 'isolated-ink-diff',
          description: `${sel} paints inside the intersection (measured with ${other} hidden)`,
          region: roundRect(clip),
          changedPixels: ink,
          totalPixels: cap.total,
          noisePixels: cap.noise,
          conclusion,
          ...(conclusion === 'inconclusive' ? { note: 'Region changes between identical captures (animation/video).' } : {}),
        });
      }
      // With both present, which one is actually seen in the intersection?
      const seenA = diffCount(cap.base, noA, t.pixelDelta) - cap.noise >= t.visualMinChangedPixels;
      const seenB = diffCount(cap.base, noB, t.pixelDelta) - cap.noise >= t.visualMinChangedPixels;
      if (verdict(inkA) === 'confirmed' && verdict(inkB) === 'confirmed') {
        if (seenA && !seenB) res.notes.push(`${sb} is covered by ${sa} inside the intersection (occluded).`);
        else if (seenB && !seenA) res.notes.push(`${sa} is covered by ${sb} inside the intersection (occluded).`);
        else res.notes.push('Both elements are visible on top of each other inside the intersection.');
      }
      return;
    }
    case 'cover': {
      await api.scrollTo(page, plan.scroll.x, plan.scroll.y);
      const live = await api.remeasure(page, [plan.target]);
      const lr = live.rects[0];
      if (!lr) {
        res.detached = true;
        return;
      }
      const x = lr.x + lr.w * plan.fx;
      const y = lr.y + lr.h * plan.fy;
      const stack = await api.stackAt(page, x, y);
      const top = stack[0];
      res.coverReproduced = top !== undefined && top !== plan.target && !model.isAncestor(plan.target, top);
      const clip = viewportClip(lr, model);
      if (clip) {
        res.visual.push(
          ...(await differential(page, clip, t, [
            {
              method: 'hide-obstructor-diff',
              description: `visibility:hidden on obstructor ${model.el(plan.obstructor).selector}; pixels over the control change only if it visibly covers it`,
              apply: () => api.override(page, plan.obstructor, 'visibility', 'hidden'),
            },
          ])),
        );
      }
      return;
    }
    case 'unclip': {
      const clip = await locate(ctx, plan.element, plan.region);
      if (!clip) {
        res.errors.push('hidden region lies outside the viewport; visual confirmation skipped');
        return;
      }
      const before = await api.remeasure(page, [plan.clipper, plan.element]);
      const checks = await differential(page, clip, t, [
        {
          method: 'unclip-diff',
          description:
            `overflow:visible on ${model.el(plan.clipper).selector} and magenta text on ${model.el(plan.element).selector}; ` +
            'its content must paint in the clipped-away region (the colour change avoids same-colour-as-background false negatives)',
          apply: async () => {
            await api.override(page, plan.clipper, 'overflow', 'visible');
            await api.override(page, plan.clipper, 'contain', 'none');
            await api.override(page, plan.element, 'color', '#ff00ff');
            await api.override(page, plan.element, '-webkit-text-fill-color', '#ff00ff');
            const after = await api.remeasure(page, [plan.clipper, plan.element]);
            res.layoutShifted = after.rects.some((r, k) => {
              const b = before.rects[k];
              return !r || !b || Math.abs(r.x - b.x) > 0.5 || Math.abs(r.y - b.y) > 0.5 || Math.abs(r.w - b.w) > 0.5 || Math.abs(r.h - b.h) > 0.5;
            });
          },
        },
      ]);
      if (res.layoutShifted) for (const c of checks) {
        c.conclusion = 'inconclusive';
        c.note = 'Removing the clip changed layout, so the pixel difference is not attributable to the clipped content alone.';
      }
      res.visual.push(...checks);
      return;
    }
    case 'spill': {
      const clip = await locate(ctx, plan.element, plan.region);
      if (!clip) {
        res.errors.push('spilled region is outside the viewport; visual confirmation skipped');
        return;
      }
      res.visual.push(
        ...(await differential(page, clip, t, [
          {
            method: 'hide-element-diff',
            description: `visibility:hidden on ${model.el(plan.element).selector}; pixels outside its container must change`,
            apply: () => api.override(page, plan.element, 'visibility', 'hidden'),
          },
        ])),
      );
      return;
    }
    case 'occlusion': {
      const clip = await locate(ctx, plan.text, plan.region);
      if (!clip) {
        res.errors.push('covered text line is outside the viewport after scrolling; visual confirmation skipped');
        return;
      }
      const magenta = async (): Promise<void> => {
        await api.override(page, plan.text, 'color', '#ff00ff');
        await api.override(page, plan.text, '-webkit-text-fill-color', '#ff00ff');
      };
      const hideO = () => api.override(page, plan.occluder, 'visibility', 'hidden');
      const cap = await captureStates(page, clip, t, [
        { name: 'magenta', apply: magenta },
        { name: 'hideO', apply: hideO },
        { name: 'hideO+magenta', apply: async () => (await hideO(), magenta()) },
      ]);
      const visibleNow = diffCount(cap.base, cap.shots.get('magenta')!, t.pixelDelta);
      const revealed = diffCount(cap.shots.get('hideO')!, cap.shots.get('hideO+magenta')!, t.pixelDelta);
      const occluded = revealed > 0 ? 1 - visibleNow / revealed : 0;
      let conclusion: VisualCheck['conclusion'];
      if (cap.noise > cap.total * 0.02) conclusion = 'inconclusive';
      else if (revealed - cap.noise < t.visualMinChangedPixels) conclusion = 'not-visible';
      else conclusion = occluded >= 0.5 ? 'confirmed' : 'not-visible';
      res.visual.push({
        method: 'recolour-occlusion-diff',
        description:
          `Recolour ${model.el(plan.text).selector} magenta: ${visibleNow} px change with the occluder present vs ${revealed} px with ` +
          `${model.el(plan.occluder).selector} hidden (${Math.round(occluded * 100)}% of the text ink is covered)`,
        region: roundRect(clip),
        changedPixels: revealed - visibleNow,
        totalPixels: cap.total,
        noisePixels: cap.noise,
        conclusion,
      });
      return;
    }
    case 'focus': {
      res.focus = await api.focusProbe(page, plan.element);
      return;
    }
    case 'hscroll': {
      res.maxScrollX = await api.maxScrollX(page);
      return;
    }
    case 'reach': {
      res.reach = await api.reachProbe(page, plan.element);
      if (res.reach === null) res.detached = true;
      return;
    }
  }
}

function decide(c: Candidate, r: Results, t: Thresholds): Omit<VerifiedCandidate, 'cand' | 'evidence'> {
  let status: StatusT = c.maxStatus;
  let confidence = c.confidence;
  let severity = c.severity;
  const notes: string[] = [];
  let suppressed: VerifiedCandidate['suppressed'];
  const visual = r.visual;
  const allConfirmed = visual.length > 0 && visual.every((v) => v.conclusion === 'confirmed');
  const anyNotVisible = visual.some((v) => v.conclusion === 'not-visible');

  if (r.detached) {
    return { status: 'blocked', severity, confidence: 0, notes: ['Element was detached from the DOM during verification.'] };
  }
  switch (c.category) {
    case 'overlap':
      if (c.measurements.variant === 'occlusion') {
        if (allConfirmed) confidence = 0.9;
        else if (anyNotVisible) {
          suppressed = {
            rule: 'no-visible-change',
            reason: 'Recolouring the text shows it is still visible above the hit-tested element (e.g. a transparent overlay), so it is not occluded.',
          };
        } else {
          status = 'potential';
          confidence = 0.5;
          notes.push('Occlusion could not be visually confirmed.');
        }
        break;
      }
      if (allConfirmed) confidence = 0.92;
      else if (anyNotVisible) {
        suppressed = {
          rule: 'no-visible-change',
          reason: 'One of the elements paints nothing inside the intersection even when the other is hidden: the boxes overlap but no content collides.',
        };
      } else if (r.stackHasBoth) {
        confidence = 0.7;
        notes.push('Visual check inconclusive; both elements are present in the hit-test stack at the intersection.');
      } else {
        status = 'potential';
        confidence = 0.5;
        notes.push('Visual check inconclusive and hit-test stack did not contain both elements.');
      }
      break;
    case 'obstructed-target':
      if (r.coverReproduced === false) {
        status = 'potential';
        confidence = 0.5;
        notes.push('Re-test at the same scroll position did not reproduce the interception.');
      } else {
        confidence = r.coverReproduced ? 0.9 : 0.7;
        const v = visual[0];
        if (v?.conclusion === 'confirmed') notes.push('The obstructing element visibly paints over the control.');
        if (v?.conclusion === 'not-visible')
          notes.push('The obstructing element is invisible over the control (transparent overlay): it looks clickable but clicks are intercepted.');
      }
      break;
    case 'text-clipping':
    case 'clipped-target':
    case 'popup-clipping':
      if (c.category === 'popup-clipping' && c.measurements.variant === 'exceeds-viewport') {
        const stillOut = r.reach ? Math.max(r.reach.beyondBottom, r.reach.beyondRight) : 0;
        if (r.reach && stillOut >= t.clipMinPx) {
          confidence = 0.92;
          notes.push(`After scrolling the window and every scrollable ancestor to the end, ${round2(stillOut)}px of it is still outside the viewport.`);
        } else {
          status = 'potential';
          confidence = 0.5;
          notes.push('Scrolling to the end brought it fully into view; it may be reachable after all.');
        }
        break;
      }
      if (allConfirmed) confidence = 0.95;
      else if (anyNotVisible) {
        if (c.category === 'text-clipping') {
          suppressed = {
            rule: 'no-visible-change',
            reason: 'Removing the clip revealed no additional pixels: only empty line-box space was clipped.',
          };
        } else {
          status = 'potential';
          severity = 'low';
          confidence = 0.45;
          notes.push('Removing the clip revealed no additional pixels; only empty box area appears to be clipped.');
        }
      } else {
        confidence = 0.75;
        notes.push('Visual confirmation inconclusive; the geometric measurement (exact element and clip boxes) stands.');
      }
      break;
    case 'container-overflow':
      if (allConfirmed) confidence = 0.9;
      else if (anyNotVisible) {
        // Either nothing paints there, or the spill is hidden behind later content: lost content is still a defect.
        status = 'potential';
        severity = 'low';
        confidence = 0.45;
        notes.push('Spilled content is not visible outside the container (transparent, or covered by later content).');
      } else {
        status = 'potential';
        confidence = 0.55;
        notes.push('Spill could not be visually confirmed.');
      }
      break;
    case 'viewport-overflow':
      if (c.measurements.variant === 'horizontal-scroll') {
        if ((r.maxScrollX ?? 0) >= t.viewportOverflowMinPx) {
          confidence = 0.95;
          c.measurements.maxScrollX = r.maxScrollX;
        } else {
          status = 'potential';
          confidence = 0.5;
          notes.push(`window.scrollTo could only reach scrollX=${r.maxScrollX ?? 0}.`);
        }
      }
      break;
    case 'offscreen-target': {
      const f = r.focus;
      const full = Number(c.measurements.hiddenFraction ?? 0) >= 0.995;
      if (f && full && f.focused && f.inViewportFraction >= 0.9 && !f.windowScrolled && !f.ancestorScrolled) {
        suppressed = {
          rule: 'reachable-on-focus',
          reason: 'The control moves into view when focused without any scrolling (skip-link pattern).',
        };
      } else {
        confidence = f ? 0.85 : 0.75;
        if (f?.focused && (f.windowScrolled || f.ancestorScrolled) && f.inViewportFraction > 0) {
          notes.push('Keyboard focus scrolls a clipped area to reveal it, but pointer users cannot scroll there.');
        }
      }
      break;
    }
    case 'popup-placement':
      confidence = 0.8;
      break;
    default:
      break;
  }
  if (r.drift > 1) {
    status = 'potential';
    confidence = Math.max(0.2, confidence - 0.25);
    notes.push(`Layout moved by up to ${round2(r.drift)}px between measurements (animation or late-loading content); re-run to confirm.`);
  }
  notes.push(...r.notes, ...r.errors);
  if (c.maxStatus === 'potential' && status === 'verified') status = 'potential';
  const liveCheck = visual.length > 0 || r.focus || r.reach || r.coverReproduced !== undefined || r.maxScrollX !== undefined;
  if (status === 'verified' && !liveCheck) {
    confidence = Math.min(confidence, 0.8);
    notes.push(
      'Verified by exact geometry re-measured in the live page; no pixel or interaction check was possible for this case ' +
        '(e.g. the affected region lies outside the viewport).',
    );
  }
  return { status, severity, confidence: round2(Math.min(0.98, confidence)), notes, ...(suppressed ? { suppressed } : {}) };
}

async function captureEvidence(ctx: VerifyContext, c: Candidate, name: string): Promise<Pick<Evidence, 'screenshot' | 'rawScreenshot'>> {
  if (!ctx.evidenceDir) return { screenshot: null, rawScreenshot: null };
  const { page, model } = ctx;
  await api.scrollTo(page, 0, 0);
  const els = c.elements.slice(0, 8);
  const live = await api.reveal(page, els.map((e) => e.index));
  const rects = live.rects.filter((r): r is Rect => !!r && r.w > 0 && r.h > 0);
  const u = union(rects);
  if (!u) return { screenshot: null, rawScreenshot: null };
  const clip = viewportClip(pad(u, 24), model);
  if (!clip) return { screenshot: null, rawScreenshot: null };
  const raw = await shot(page, clip);
  const boxes = els
    .map((e, k) => ({ rect: live.rects[k], role: e.role }))
    .filter((b): b is { rect: Rect; role: typeof b.role } => !!b.rect)
    .map((b) => ({ role: b.role, rect: { x: b.rect.x - clip.x, y: b.rect.y - clip.y, w: b.rect.w, h: b.rect.h } }));
  mkdirSync(ctx.evidenceDir, { recursive: true });
  const rawPath = join(ctx.evidenceDir, `${name}.raw.png`);
  const annPath = join(ctx.evidenceDir, `${name}.png`);
  writeFileSync(rawPath, encode(raw));
  writeFileSync(annPath, encode(annotate(raw, boxes)));
  return { screenshot: annPath, rawScreenshot: rawPath };
}

/** Run verification plans, stability re-measurement and evidence capture for each candidate. */
export async function verifyCandidates(ctx: VerifyContext, cands: Candidate[]): Promise<{ results: VerifiedCandidate[]; budgetExceeded: boolean }> {
  const { page, model } = ctx;
  await api.scrollTo(page, 0, 0);
  const indices = [...new Set(cands.flatMap((c) => c.elements.map((e) => e.index)))];
  await page.waitForTimeout(250);
  const re = await api.remeasure(page, indices);
  const drift = new Map<number, number>();
  indices.forEach((idx, k) => {
    const a = model.el(idx).rect;
    const b = re.rects[k];
    drift.set(idx, b ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h)) : Infinity);
  });

  const ordered = [...cands].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const results: VerifiedCandidate[] = [];
  const counter = new Map<string, number>();
  let budgetExceeded = false;
  for (const [n, c] of ordered.entries()) {
    const maxDrift = Math.max(0, ...c.elements.map((e) => drift.get(e.index) ?? 0));
    const evidence = emptyEvidence();
    evidence.stability = { remeasuredAfterMs: 250, maxDriftPx: Number.isFinite(maxDrift) ? round2(maxDrift) : -1, stable: maxDrift <= 1 };
    const hitTests = c.measurements.hitTests;
    if (Array.isArray(hitTests)) {
      evidence.hitTests = hitTests as Evidence['hitTests'];
      delete c.measurements.hitTests;
    }
    if (!Number.isFinite(maxDrift)) {
      results.push({ cand: c, status: 'blocked', severity: c.severity, confidence: 0, evidence, notes: ['An involved element disappeared before verification.'] });
      continue;
    }
    if (n >= ctx.budget) {
      budgetExceeded = true;
      results.push({
        cand: c,
        status: 'potential',
        severity: c.severity,
        confidence: round2(Math.min(c.confidence, 0.5)),
        evidence,
        notes: ['Not verified: per-configuration verification budget exhausted (raise maxVerifyPerConfig).'],
      });
      continue;
    }
    const res: Results = { drift: maxDrift, visual: [], errors: [], notes: [] };
    for (const plan of c.verify) {
      try {
        await runPlan(ctx, plan, res);
      } catch (err) {
        res.errors.push(`Verification step '${plan.kind}' failed: ${(err as Error).message.split('\n')[0]}`);
        await api.restore(page).catch(() => undefined);
      }
    }
    const decision = decide(c, res, ctx.t);
    evidence.visual = res.visual;
    if (res.focus !== undefined) evidence.focusProbe = res.focus as unknown as Record<string, unknown>;
    if (res.reach) evidence.scrollProbe = res.reach as unknown as Record<string, unknown>;
    if (!decision.suppressed) {
      const k = (counter.get(c.category) ?? 0) + 1;
      counter.set(c.category, k);
      try {
        Object.assign(evidence, await captureEvidence(ctx, c, `${c.category}-${k}`));
      } catch (err) {
        decision.notes.push(`Screenshot capture failed: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    results.push({ cand: c, evidence, ...decision });
  }
  await api.scrollTo(page, 0, 0);
  return { results, budgetExceeded };
}
