import { type Candidate, type Detector, cssq } from '../candidate.js';
import { area, contains, intersect, overlapOfLists, round2, roundRect, union } from '../geometry.js';
import type { ContentKind, SnapshotModel } from '../model.js';
import type { Rect, TextProbe } from '../snapshot-types.js';

const CELL = 96;
/** Glyph ink rarely fills the font content area; trim it so line-box slack is not "overlap". */
const TEXT_INK_INSET = 0.14;

interface Item {
  i: number;
  kind: ContentKind;
  rects: Rect[];
  bbox: Rect;
}

function inkRects(rects: Rect[]): Rect[] {
  return rects
    .map((r) => ({ x: r.x, y: r.y + r.h * TEXT_INK_INSET, w: r.w, h: r.h * (1 - 2 * TEXT_INK_INSET) }))
    .filter((r) => r.w > 0 && r.h > 0);
}

/**
 * A row/column of >= 3 same-kind siblings that all overlap their neighbour by a
 * consistent amount (e.g. an avatar stack built with negative margins).
 */
function stackPattern(model: SnapshotModel, a: number, b: number, cache: Map<string, boolean>): boolean {
  const pa = model.el(a).parent;
  if (pa < 0 || pa !== model.el(b).parent) return false;
  const sig = model.signature(a);
  if (sig !== model.signature(b)) return false;
  const key = `${pa}|${sig}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const sibs = (model.children[pa] ?? [])
    .filter((c) => model.signature(c) === sig && model.el(c).flags.visible)
    .map((c) => model.el(c).rect);
  let result = false;
  if (sibs.length >= 3) {
    for (const axis of ['x', 'y'] as const) {
      const size = axis === 'x' ? 'w' : 'h';
      const sorted = [...sibs].sort((p, q) => p[axis] - q[axis]);
      const overlaps: number[] = [];
      let advancing = true;
      for (let k = 1; k < sorted.length; k++) {
        const prev = sorted[k - 1]!;
        const cur = sorted[k]!;
        // Each item must start further along the axis than the previous one (a stack, not a row seen side-on).
        if (cur[axis] - prev[axis] < 2) advancing = false;
        overlaps.push(prev[axis] + prev[size] - cur[axis]);
      }
      const min = Math.min(...overlaps);
      const max = Math.max(...overlaps);
      if (advancing && min > 0 && max - min <= 2) result = true;
    }
  }
  cache.set(key, result);
  return result;
}

function styleHints(model: SnapshotModel, i: number): Record<string, unknown> {
  const s = model.el(i).style;
  return {
    position: s.position,
    zIndex: s.zIndex,
    margin: s.margin,
    transform: s.transform,
    float: s.float,
    width: s.width,
    height: s.height,
  };
}

export const overlapDetector: Detector = {
  category: 'overlap',
  description:
    'Visible content (text glyph boxes, controls, media) of unrelated elements painting over each other. ' +
    'Popups/dialogs, overlays fully inside media, consistent stack patterns and fixed/sticky-over-media are recognised as intentional.',
  run({ model, t }) {
    const items: Item[] = [];
    for (const e of model.els) {
      const kind = model.contentKind(e.i);
      if (!kind) continue;
      let rects = model.contentRects(e.i, kind).filter((r) => r.w >= 1 && r.h >= 1);
      if (kind === 'text') rects = inkRects(rects);
      const bbox = union(rects);
      if (!bbox) continue;
      items.push({ i: e.i, kind, rects, bbox });
    }

    const grid = new Map<string, number[]>();
    items.forEach((it, k) => {
      const x1 = Math.floor(it.bbox.x / CELL);
      const x2 = Math.floor((it.bbox.x + it.bbox.w) / CELL);
      const y1 = Math.floor(it.bbox.y / CELL);
      const y2 = Math.floor((it.bbox.y + it.bbox.h) / CELL);
      for (let gx = x1; gx <= x2; gx++) {
        for (let gy = y1; gy <= y2; gy++) {
          const key = `${gx},${gy}`;
          const bucket = grid.get(key);
          if (bucket) bucket.push(k);
          else grid.set(key, [k]);
        }
      }
    });

    const seen = new Set<string>();
    const stackCache = new Map<string, boolean>();
    const out: Candidate[] = [];
    for (const bucket of grid.values()) {
      for (let p = 0; p < bucket.length; p++) {
        for (let q = p + 1; q < bucket.length; q++) {
          const A = items[bucket[p]!]!;
          const B = items[bucket[q]!]!;
          const pairKey = A.i < B.i ? `${A.i}|${B.i}` : `${B.i}|${A.i}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          if (model.related(A.i, B.i)) continue;
          const ea = model.el(A.i);
          const eb = model.el(B.i);
          if (ea.labelControl === B.i || eb.labelControl === A.i) continue;
          const ov = overlapOfLists(A.rects, B.rects);
          if (!ov.largest) continue;
          if (ov.largest.w < t.overlapMinPx || ov.largest.h < t.overlapMinPx || ov.area < t.overlapMinArea) continue;
          const c = buildCandidate(model, A, B, ov.area, ov.largest);
          applySuppressions(model, A, B, c, stackCache);
          out.push(c);
        }
      }
    }
    return out;
  },
};

function buildCandidate(model: SnapshotModel, A: Item, B: Item, overlapArea: number, largest: Rect): Candidate {
  const areaA = A.rects.reduce((s, r) => s + area(r), 0);
  const areaB = B.rects.reduce((s, r) => s + area(r), 0);
  const fraction = overlapArea / Math.max(1, Math.min(areaA, areaB));
  const kinds = [A.kind, B.kind].sort().join('+');
  let severity: Candidate['severity'] = 'medium';
  if (A.kind === 'interactive' && B.kind === 'interactive') severity = 'high';
  else if (kinds === 'interactive+text') severity = fraction >= 0.25 ? 'high' : 'medium';
  else if (kinds === 'text+text') severity = fraction >= 0.15 ? 'high' : 'medium';
  const ea = model.el(A.i);
  const eb = model.el(B.i);
  const [first, second] = ea.selector < eb.selector ? [A, B] : [B, A];
  const sa = model.el(first.i).selector;
  const sb = model.el(second.i).selector;
  return {
    category: 'overlap',
    key: `overlap|${sa}|${sb}`,
    title: `Overlapping ${A.kind === B.kind ? A.kind : `${A.kind}/${B.kind}`} content`,
    description:
      `${model.label(A.i)} and ${model.label(B.i)} paint over each other: ` +
      `${round2(largest.w)}×${round2(largest.h)}px intersection, ${Math.round(fraction * 100)}% of the smaller element's visible content.`,
    severity,
    confidence: 0.7,
    maxStatus: 'verified',
    elements: [
      { index: first.i, role: 'subject' },
      { index: second.i, role: 'subject' },
    ],
    measurements: {
      intersection: roundRect(largest),
      overlapAreaPx: round2(overlapArea),
      fractionOfSmaller: round2(fraction),
      kinds: [first.kind, second.kind],
      styleHints: { [sa]: styleHints(model, first.i), [sb]: styleHints(model, second.i) },
    },
    verify: [{ kind: 'overlap', a: first.i, b: second.i, region: largest }],
    consoleCheck:
      `(() => { const a = document.querySelector(${cssq(sa)}).getBoundingClientRect(), ` +
      `b = document.querySelector(${cssq(sb)}).getBoundingClientRect(); ` +
      `return { overlapX: Math.min(a.right, b.right) - Math.max(a.left, b.left), ` +
      `overlapY: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) }; })()`,
    notes: ['styleHints are computed-style facts for root-cause triage, not a proven cause.'],
  };
}

/** The subtree (child of the lowest common ancestor) that contains `top` but not `text`. */
function occluderRoot(model: SnapshotModel, text: number, top: number): number {
  const anc = new Set([text, ...model.ancestors(text)]);
  let cur = top;
  let prev = top;
  while (cur >= 0 && !anc.has(cur)) {
    prev = cur;
    cur = model.el(cur).parent;
  }
  return prev;
}

interface Occluded {
  i: number;
  valid: TextProbe[];
  blocked: TextProbe[];
  top: number;
}

export const occludedTextDetector: Detector = {
  category: 'overlap',
  description:
    'Text hidden behind an unrelated element painted above it: hit tests along each text line (page scrolled in viewport steps) return another ' +
    'element; verified by recolouring the text and hiding the occluding subtree.',
  run({ model }) {
    const openModal = model.els.find((e) => e.flags.modal && e.flags.visible);
    const vpArea = area(model.viewport);
    const groups = new Map<number, Occluded[]>();
    const out: Candidate[] = [];
    for (const e of model.els) {
      if (!e.textProbes?.length) continue;
      const region = model.paintRegion(e.i, { includeSelf: true });
      const valid = e.textProbes.filter((p) => p.x >= region.x1 && p.x <= region.x2 && p.y >= region.y1 && p.y <= region.y2);
      const blocked = valid.filter((p) => {
        if (p.ok || p.top < 0 || model.related(p.top, e.i)) return false;
        // Scrolling content under a fixed/sticky header is normal.
        const k = model.layer(p.top).kind;
        return !(p.sy > 0 && (k === 'fixed' || k === 'sticky'));
      });
      if (!blocked.length) continue;
      const counts = new Map<number, number>();
      for (const p of blocked) counts.set(p.top, (counts.get(p.top) ?? 0) + 1);
      const top = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
      const occ = occluderRoot(model, e.i, top);
      const item: Occluded = { i: e.i, valid, blocked, top };

      const lo = model.layer(top);
      const lt = model.layer(e.i);
      let suppressed: Candidate['suppressed'];
      if ((lo.kind === 'popup' || lo.kind === 'modal' || lo.kind === 'top-layer') && lo.root !== lt.root) {
        suppressed = { rule: 'intentional-overlay', reason: `${model.label(lo.root)} is an open ${lo.kind} layer designed to overlay page content.` };
      } else if (openModal && lo.kind === 'fixed' && !model.isAncestor(openModal.i, e.i)) {
        const vis = model.visibleRect(occ);
        if (vis && area(vis) >= 0.9 * vpArea) {
          suppressed = { rule: 'covered-by-open-modal', reason: `${model.label(occ)} is a full-viewport backdrop shown with the open modal ${model.label(openModal.i)}.` };
        }
      }
      if (suppressed) {
        out.push({ ...occlusionCandidate(model, occ, [item]), suppressed, severity: 'info' });
        continue;
      }
      groups.set(occ, [...(groups.get(occ) ?? []), item]);
    }
    for (const [occ, items] of groups) out.push(occlusionCandidate(model, occ, items));
    return out;
  },
};

function occlusionCandidate(model: SnapshotModel, occ: number, items: Occluded[]): Candidate {
  const worst = items.reduce((a, b) => (b.blocked.length / b.valid.length > a.blocked.length / a.valid.length ? b : a));
  const fraction = worst.blocked.length / worst.valid.length;
  const te = model.el(worst.i);
  const p = worst.blocked[0]!;
  const line = te.text?.rects.find((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) ?? te.text!.union;
  // Verify only the covered part of the line, so visible text beside the occluder does not dilute the measurement.
  const occVis = model.visibleRect(occ);
  const region = (occVis && intersect(line, occVis)) || line;
  const fixedOccluder = model.layer(worst.top).kind === 'fixed' && model.layer(worst.i).kind !== 'fixed';
  const oe = model.el(occ);
  const c: Candidate = {
    category: 'overlap',
    key: `overlap|occluded|${oe.selector}`,
    title: fixedOccluder ? 'Text is covered by a fixed-position element at the initial scroll position' : 'Text is hidden behind another element',
    description:
      `${model.label(occ)} is painted over text of ${items.length} element(s): ` +
      items
        .slice(0, 4)
        .map((it) => `${model.label(it.i)} (${it.blocked.length}/${it.valid.length} probe points covered)`)
        .join('; ') + (items.length > 4 ? '; …' : '') + '.',
    severity: fraction >= 0.5 ? 'high' : 'medium',
    confidence: 0.7,
    maxStatus: fixedOccluder ? 'potential' : 'verified',
    elements: [{ index: occ, role: 'obstructor' }, ...items.map((it) => ({ index: it.i, role: 'subject' as const }))],
    measurements: {
      variant: 'occlusion',
      occluder: {
        selector: oe.selector,
        position: oe.style.position,
        zIndex: oe.style.zIndex,
        rect: roundRect(oe.rect),
        topmostHit: model.el(worst.top).selector,
      },
      covered: items.map((it) => ({
        selector: model.el(it.i).selector,
        text: model.el(it.i).textSnippet,
        coveredProbes: it.blocked.length,
        validProbes: it.valid.length,
        points: it.blocked.slice(0, 4).map((b) => ({ x: b.x, y: b.y, scrollY: b.sy })),
      })),
    },
    verify: [{ kind: 'occlusion', text: worst.i, occluder: occ, region }],
    consoleCheck:
      `(() => { window.scrollTo(0, ${p.sy}); const hit = document.elementFromPoint(${p.x}, ${round2(p.y - p.sy)}); ` +
      `return { hit, textElement: document.querySelector(${cssq(te.selector)}), covered: !document.querySelector(${cssq(te.selector)}).contains(hit) }; })()`,
    notes: fixedOccluder ? ['The occluder is position:fixed; confirm whether the page reserves space for it.'] : [],
  };
  c.rebuild = (keep) => {
    const rest = items.filter((it) => keep.includes(it.i));
    return rest.length ? occlusionCandidate(model, occ, rest) : null;
  };
  return c;
}

function applySuppressions(model: SnapshotModel, A: Item, B: Item, c: Candidate, stackCache: Map<string, boolean>): void {
  const la = model.layer(A.i);
  const lb = model.layer(B.i);
  if (la.root !== lb.root) {
    const overlayA = la.kind === 'popup' || la.kind === 'modal' || la.kind === 'top-layer';
    const overlayB = lb.kind === 'popup' || lb.kind === 'modal' || lb.kind === 'top-layer';
    if (overlayA || overlayB) {
      const o = overlayA ? la : lb;
      c.suppressed = {
        rule: 'intentional-overlay',
        reason: `${model.label(o.root)} is an open ${o.kind} layer designed to overlay page content.`,
      };
      return;
    }
    const fixedA = la.kind === 'fixed';
    const fixedB = lb.kind === 'fixed';
    if (fixedA !== fixedB) {
      const flow = fixedA ? B : A;
      const fixed = fixedA ? la : lb;
      if (flow.kind === 'media') {
        c.suppressed = {
          rule: 'fixed-or-sticky-media',
          reason: `Fixed element ${model.label(fixed.root)} sits over media ${model.label(flow.i)} (common transparent-header design).`,
        };
        return;
      }
      c.title = 'Content covered by a fixed-position element at the initial scroll position';
      c.maxStatus = 'potential';
      c.severity = 'medium';
      c.confidence = 0.6;
      c.notes.push(
        `${model.label(fixed.root)} is position:fixed. At scroll (0,0) it covers ${model.label(flow.i)}; ` +
          'confirm whether the page reserves space for it (e.g. padding-top).',
      );
    }
  }
  for (const [m, other] of [
    [A, B],
    [B, A],
  ] as const) {
    if (m.kind === 'media') {
      const mediaVis = model.visibleRect(m.i);
      const inside = mediaVis && area(other.bbox) > 0 && contains(mediaVis, other.bbox, 1);
      if (inside) {
        c.suppressed = {
          rule: 'overlay-on-media',
          reason: `${model.label(other.i)} is placed entirely within media ${model.label(m.i)} (caption/control-over-media pattern).`,
        };
        return;
      }
    }
  }
  if (stackPattern(model, A.i, B.i, stackCache)) {
    c.suppressed = {
      rule: 'intentional-stack',
      reason: `Siblings like ${model.label(A.i)} overlap their neighbours by a consistent amount (stack pattern, e.g. avatar group).`,
    };
  }
}
