import { type Candidate, type Detector, cssq } from '../candidate.js';
import { area, hiddenOutside, isUnbounded, round2, roundRect, union } from '../geometry.js';
import type { SnapshotModel } from '../model.js';
import type { Rect } from '../snapshot-types.js';
import type { SeverityT } from '../../report/schema.js';

const CAROUSEL = /carousel|slide/i;

interface Member {
  i: number;
  hiddenFraction: number;
  maxHiddenX: number;
  maxHiddenY: number;
  hiddenRects: Rect[];
  severity: SeverityT;
}

const RANK: Record<SeverityT, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const maxSeverity = (ms: Member[]): SeverityT =>
  ms.reduce<SeverityT>((s, m) => (RANK[m.severity] > RANK[s] ? m.severity : s), 'info');
const lower = (s: SeverityT): SeverityT => (s === 'critical' ? 'high' : s === 'high' ? 'medium' : s === 'medium' ? 'low' : s);

function carouselAncestor(model: SnapshotModel, c: number): boolean {
  for (const i of [c, ...model.ancestors(c)]) {
    const e = model.el(i);
    if (CAROUSEL.test(e.attrs.ariaRoledescription ?? '')) return true;
  }
  return false;
}

/** line-clamp anywhere from the text element up to (and including) its clipper. */
function lineClampBetween(model: SnapshotModel, from: number, clipper: number): boolean {
  for (let k = from; k >= 0; k = model.el(k).parent) {
    if (model.el(k).style.lineClamp !== 'none') return true;
    if (k === clipper) break;
  }
  return false;
}

function collapsed(model: SnapshotModel, c: number): boolean {
  const b = model.el(c).clipBox;
  return b.h <= 1 || b.w <= 1;
}

function largestRect(rects: Rect[]): Rect | null {
  let best: Rect | null = null;
  for (const r of rects) if (!best || area(r) > area(best)) best = r;
  return best;
}

function clipperFacts(model: SnapshotModel, c: number): Record<string, unknown> {
  const e = model.el(c);
  return {
    selector: e.selector,
    overflowX: e.style.overflowX,
    overflowY: e.style.overflowY,
    clipBox: roundRect(e.clipBox),
    height: e.style.height,
    maxHeight: e.style.maxHeight,
    width: e.style.width,
    whiteSpace: e.style.whiteSpace,
    flexWrap: e.style.flexWrap,
    scrollWidth: e.scroll.sw,
    scrollHeight: e.scroll.sh,
    clientWidth: e.scroll.cw,
    clientHeight: e.scroll.ch,
  };
}

/** Group members by clipper and emit one candidate per clipper. */
function emitGroups(
  model: SnapshotModel,
  groups: Map<number, Member[]>,
  suppressedOut: Candidate[],
  make: (clipper: number, members: Member[]) => Candidate,
): Candidate[] {
  const out: Candidate[] = [...suppressedOut];
  const build = (clipper: number, members: Member[]): Candidate => {
    const c = make(clipper, members);
    c.rebuild = (keep) => {
      const rest = members.filter((m) => keep.includes(m.i));
      return rest.length ? build(clipper, rest) : null;
    };
    return c;
  };
  for (const [clipper, members] of groups) out.push(build(clipper, members));
  return out;
}

export const textClippingDetector: Detector = {
  category: 'text-clipping',
  description:
    'Text whose glyph line boxes are cut by an overflow:hidden/clip box (its own or an ancestor). ' +
    'text-overflow:ellipsis, line-clamp, collapsed (0-size) containers, carousels and aria-hidden content are treated as intentional.',
  run({ model, t }) {
    const groups = new Map<number, Member[]>();
    const suppressed: Candidate[] = [];
    for (const e of model.els) {
      const f = e.flags;
      if (!f.visible || !e.text || f.srOnly || f.ignored || f.replaced) continue;
      const region = model.hiddenClipRegion(e.i, true);
      if (isUnbounded(region)) continue;
      const h = hiddenOutside(e.text.rects, region);
      if (h.maxHiddenX < t.clipMinPx && h.maxHiddenY < t.clipMinPx) continue;
      if (h.hiddenFraction < t.clipMinFraction) continue;
      const textBox = union(e.text.rects);
      if (!textBox) continue;
      const clipper = model.nearestHiddenClipperCutting(e.i, textBox, true);
      if (clipper < 0) continue;
      const c = model.el(clipper);
      const horizontalOnly = h.maxHiddenY < t.clipMinPx;
      const verticalOnly = h.maxHiddenX < t.clipMinPx;
      const full = h.hiddenFraction >= 0.995;

      let rule: Candidate['suppressed'] | undefined;
      const lineClamped = lineClampBetween(model, e.i, clipper);
      if (horizontalOnly && (c.style.textOverflow === 'ellipsis' || e.style.textOverflow === 'ellipsis')) {
        rule = { rule: 'permitted-truncation', reason: `text-overflow: ellipsis on ${c.selector} signals intentional truncation.` };
      } else if (verticalOnly && lineClamped) {
        rule = { rule: 'permitted-truncation', reason: `-webkit-line-clamp on/above ${e.selector} signals intentional truncation.` };
      } else if (collapsed(model, clipper)) {
        rule = { rule: 'collapsed-container', reason: `${c.selector} is collapsed to ${c.clipBox.w}×${c.clipBox.h}px (closed accordion/drawer pattern).` };
      } else if (full && (f.ariaHidden || f.inert)) {
        rule = { rule: 'hidden-content', reason: `${e.selector} is aria-hidden/inert, so hiding it is intentional.` };
      } else if (full && carouselAncestor(model, clipper)) {
        rule = { rule: 'carousel-viewport', reason: `${c.selector} is a carousel viewport; off-screen slides are hidden by design.` };
      }
      if (rule) {
        suppressed.push(single(model, e.i, clipper, h, rule));
        continue;
      }
      const severity: SeverityT = full ? 'medium' : h.hiddenFraction > 0.25 ? 'high' : 'medium';
      const list = groups.get(clipper) ?? [];
      list.push({ i: e.i, ...h, severity });
      groups.set(clipper, list);
    }
    return emitGroups(model, groups, suppressed, (clipper, members) => {
      const c = model.el(clipper);
      const worst = members.reduce((a, b) => (b.hiddenFraction > a.hiddenFraction ? b : a));
      const selfClip = members.length === 1 && worst.i === clipper;
      const anyPartial = members.some((m) => m.hiddenFraction < 0.995);
      return {
        category: 'text-clipping',
        key: `text-clipping|${c.selector}`,
        title: anyPartial ? 'Text is cut off by overflow clipping' : 'Text is completely hidden by an overflow-clipping container',
        description: selfClip
          ? `${model.label(worst.i)} clips its own text: ${Math.round(worst.hiddenFraction * 100)}% of the glyph box area is hidden ` +
            `(${round2(worst.maxHiddenX)}px horizontally, ${round2(worst.maxHiddenY)}px vertically) with no ellipsis or line-clamp.`
          : `${model.label(clipper)} (overflow ${c.style.overflowX}/${c.style.overflowY}) hides text of ${members.length} element(s); ` +
            `worst: ${model.label(worst.i)} with ${Math.round(worst.hiddenFraction * 100)}% hidden.`,
        severity: maxSeverity(members),
        confidence: 0.75,
        maxStatus: 'verified',
        elements: selfClip
          ? [{ index: worst.i, role: 'subject' }]
          : [{ index: clipper, role: 'container' }, ...members.map((m) => ({ index: m.i, role: 'subject' as const }))],
        measurements: {
          clipper: clipperFacts(model, clipper),
          clipped: members.map((m) => ({
            selector: model.el(m.i).selector,
            text: model.el(m.i).textSnippet,
            hiddenFraction: round2(m.hiddenFraction),
            hiddenPxX: round2(m.maxHiddenX),
            hiddenPxY: round2(m.maxHiddenY),
            lines: model.el(m.i).text?.lines ?? 0,
            fontSize: model.el(m.i).style.fontSize,
            lineHeight: model.el(m.i).style.lineHeight,
          })),
        },
        verify: [{ kind: 'unclip', clipper, element: worst.i, region: largestRect(worst.hiddenRects) ?? model.el(worst.i).rect }],
        consoleCheck: `(() => { const c = document.querySelector(${cssq(c.selector)}); return { scrollWidth: c.scrollWidth, clientWidth: c.clientWidth, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight, overflow: getComputedStyle(c).overflow }; })()`,
        notes: [],
      };
    });
  },
};

function single(
  model: SnapshotModel,
  i: number,
  clipper: number,
  h: { hiddenFraction: number; maxHiddenX: number; maxHiddenY: number },
  suppressed: NonNullable<Candidate['suppressed']>,
  category: 'text-clipping' | 'clipped-target' = 'text-clipping',
): Candidate {
  return {
    category,
    key: `${category}|${model.el(clipper).selector}|${model.el(i).selector}`,
    title: 'Clipped content (suppressed)',
    description: `${model.label(i)} is ${Math.round(h.hiddenFraction * 100)}% hidden by ${model.label(clipper)}.`,
    severity: 'info',
    confidence: 0.5,
    maxStatus: 'potential',
    elements: [
      { index: i, role: 'subject' },
      { index: clipper, role: 'container' },
    ],
    measurements: { hiddenFraction: round2(h.hiddenFraction) },
    verify: [],
    consoleCheck: '',
    notes: [],
    suppressed,
  };
}

export const clippedTargetDetector: Detector = {
  category: 'clipped-target',
  description:
    'Interactive controls partly or fully cut off by an overflow:hidden/clip ancestor, so users cannot see or click them.',
  run({ model, t }) {
    const groups = new Map<number, Member[]>();
    const suppressed: Candidate[] = [];
    for (const e of model.els) {
      const f = e.flags;
      if (!f.interactive || !f.visible || f.srOnly || f.ariaHidden || f.inert || f.ignored) continue;
      const region = model.hiddenClipRegion(e.i);
      if (isUnbounded(region)) continue;
      const rects = e.fragments ?? [e.rect];
      const h = hiddenOutside(rects, region);
      if (h.maxHiddenX < t.clipMinPx && h.maxHiddenY < t.clipMinPx) continue;
      if (h.hiddenFraction < 0.1) continue;
      const bbox = union(rects);
      if (!bbox) continue;
      const clipper = model.nearestHiddenClipperCutting(e.i, bbox);
      if (clipper < 0) continue;
      const full = h.hiddenFraction >= 0.995;
      if (collapsed(model, clipper)) {
        suppressed.push(single(model, e.i, clipper, h, {
          rule: 'collapsed-container',
          reason: `${model.el(clipper).selector} is collapsed (closed accordion/drawer pattern).`,
        }, 'clipped-target'));
        continue;
      }
      if (full && carouselAncestor(model, clipper)) {
        suppressed.push(single(model, e.i, clipper, h, {
          rule: 'carousel-viewport',
          reason: `${model.el(clipper).selector} is a carousel viewport.`,
        }, 'clipped-target'));
        continue;
      }
      let severity: SeverityT = full || h.hiddenFraction >= 0.4 ? 'high' : 'medium';
      if (f.interactiveSource === 'cursor' || f.disabled) severity = lower(severity);
      const list = groups.get(clipper) ?? [];
      list.push({ i: e.i, ...h, severity });
      groups.set(clipper, list);
    }
    return emitGroups(model, groups, suppressed, (clipper, members) => {
      const c = model.el(clipper);
      const worst = members.reduce((a, b) => (b.hiddenFraction > a.hiddenFraction ? b : a));
      const fullCount = members.filter((m) => m.hiddenFraction >= 0.995).length;
      const cursorOnly = members.every((m) => model.el(m.i).flags.interactiveSource === 'cursor');
      return {
        category: 'clipped-target',
        key: `clipped-target|${c.selector}`,
        title: fullCount
          ? `${fullCount} control(s) hidden by overflow clipping`
          : 'Control partially cut off by overflow clipping',
        description:
          `${model.label(clipper)} (overflow ${c.style.overflowX}/${c.style.overflowY}, client box ` +
          `${round2(c.clipBox.w)}×${round2(c.clipBox.h)}px) clips ${members.length} interactive element(s): ` +
          members
            .slice(0, 5)
            .map((m) => `${model.label(m.i)} ${Math.round(m.hiddenFraction * 100)}% hidden`)
            .join('; ') +
          (members.length > 5 ? '; …' : '') + '.',
        severity: maxSeverity(members),
        confidence: cursorOnly ? 0.6 : 0.75,
        maxStatus: 'verified',
        elements: [{ index: clipper, role: 'container' }, ...members.map((m) => ({ index: m.i, role: 'subject' as const }))],
        measurements: {
          clipper: clipperFacts(model, clipper),
          clipped: members.map((m) => ({
            selector: model.el(m.i).selector,
            name: model.el(m.i).name,
            rect: roundRect(model.el(m.i).rect),
            hiddenFraction: round2(m.hiddenFraction),
            hiddenPxX: round2(m.maxHiddenX),
            hiddenPxY: round2(m.maxHiddenY),
          })),
        },
        verify: [{ kind: 'unclip', clipper, element: worst.i, region: largestRect(worst.hiddenRects) ?? model.el(worst.i).rect }],
        consoleCheck: `(() => { const c = document.querySelector(${cssq(c.selector)}).getBoundingClientRect(), e = document.querySelector(${cssq(model.el(worst.i).selector)}).getBoundingClientRect(); return { container: c, control: e, hiddenBelow: Math.max(0, e.bottom - c.bottom), hiddenRight: Math.max(0, e.right - c.right) }; })()`,
        notes: cursorOnly ? ['Controls were detected via cursor:pointer only (no semantic role); confirm they are clickable.'] : [],
      };
    });
  },
};
