import type { Action } from '../browser/actions.js';
import type { BrowserManager, ConfigRequest } from '../browser/session.js';
import type { TargetPolicy } from '../safety/policy.js';
import type { Thresholds } from './candidate.js';
import { consolidate } from './consolidate.js';
import { DETECTORS } from './detectors/index.js';
import { hiddenOutside, isUnbounded, round2, roundRect, type ClipRegion } from './geometry.js';
import { SnapshotModel } from './model.js';
import { collectSnapshot, elementRef, preparePage } from './runner.js';
import type { CollectOptions } from './snapshot-types.js';

export interface InspectOptions {
  url: string;
  selector: string;
  config: ConfigRequest;
  policy: TargetPolicy;
  actions: Action[];
  allowDestructiveActions: boolean;
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  settleMs: number;
  timeoutMs: number;
  collect: CollectOptions;
  thresholds: Thresholds;
}

const finiteRegion = (r: ClipRegion) => {
  const f = (n: number): number | null => (Number.isFinite(n) ? round2(n) : null);
  return { x1: f(r.x1), x2: f(r.x2), y1: f(r.y1), y2: f(r.y2) };
};

/** Measure one element and explain its clipping, reachability, layer and hit-testing. */
export async function inspectElement(browsers: BrowserManager, o: InspectOptions): Promise<Record<string, unknown>> {
  const { context, info } = await browsers.newContext(o.config);
  try {
    const page = await context.newPage();
    await preparePage(page, o);
    const snap = await collectSnapshot(page, o.collect);
    const model = new SnapshotModel(snap);
    let i = model.els.findIndex((e) => e.selector === o.selector);
    if (i < 0) i = (await page.evaluate((s) => (window as any).__uqa.indexOfSelector(s), o.selector)) as number;
    if (i < 0) {
      return { config: info, found: false, reason: `No rendered element matches ${o.selector} (it may be display:none or inside an iframe).` };
    }
    const e = model.el(i);
    const clip = model.clipInfo(i);
    const hiddenRegion = model.hiddenClipRegion(i);
    const reach = model.reachableRegion(i);
    const rects = e.fragments ?? [e.rect];
    const textClip = e.text ? hiddenOutside(e.text.rects, model.hiddenClipRegion(i, true)) : null;
    const candidates = consolidate(model, DETECTORS.flatMap((d) => d.run({ model, t: o.thresholds }))).filter((c) =>
      c.elements.some((x) => x.index === i || model.isAncestor(x.index, i)),
    );
    return {
      config: info,
      found: true,
      element: elementRef(model, i, 'subject'),
      flags: e.flags,
      style: e.style,
      scroll: e.scroll,
      layer: { ...model.layer(i), rootSelector: model.layer(i).root >= 0 ? model.el(model.layer(i).root).selector : null },
      fixedToViewport: clip.fixedToViewport,
      containingBlocks: clip.cbs.slice(0, 6).map((c) => model.el(c).selector),
      clipChain: clip.chain.map((c) => {
        const ce = model.el(c);
        return { selector: ce.selector, overflowX: ce.style.overflowX, overflowY: ce.style.overflowY, clipBox: roundRect(ce.clipBox) };
      }),
      visibleRect: model.visibleRect(i),
      hiddenByOverflow: isUnbounded(hiddenRegion) ? null : round2(hiddenOutside(rects, hiddenRegion).hiddenFraction),
      reachableRegion: finiteRegion(reach),
      outsideReachableFraction: round2(hiddenOutside(rects, reach).hiddenFraction),
      text: e.text
        ? { lines: e.text.lines, length: e.text.length, union: e.text.union, clippedFraction: textClip ? round2(textClip.hiddenFraction) : 0 }
        : null,
      hitProbes: e.probes.map((p) => ({
        mode: p.mode,
        scroll: { x: p.scrollX, y: p.scrollY },
        samples: p.samples.map((s) => ({
          x: s.x,
          y: s.y,
          outside: s.outside,
          ok: s.ok,
          top: s.top >= 0 ? model.el(s.top).selector : s.topSelector,
        })),
      })),
      candidatesInvolvingElement: candidates.map((c) => ({
        category: c.category,
        title: c.title,
        description: c.description,
        suppressed: c.suppressed ?? null,
        note: 'Unverified candidate from geometry only; run qa_audit_layout for verification and evidence.',
      })),
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}
