import { type Candidate, type Detector, cssq } from '../candidate.js';
import {
  area,
  clipRect,
  clipRegionFrom,
  hiddenOutside,
  protrusion,
  right,
  round2,
  roundRect,
  subtractRegion,
  union,
} from '../geometry.js';
import type { SnapshotModel } from '../model.js';
import type { Rect } from '../snapshot-types.js';

const hiddenOv = (o: string): boolean => o === 'hidden' || o === 'clip';
const TEXT_INK_INSET = 0.14;

function inkRects(rects: Rect[]): Rect[] {
  return rects.map((r) => ({ x: r.x, y: r.y + r.h * TEXT_INK_INSET, w: r.w, h: r.h * (1 - 2 * TEXT_INK_INSET) }));
}

/** Whether any clipping ancestor of i clips on the x axis (hidden or scroll). */
function clippedOnX(model: SnapshotModel, i: number): boolean {
  return model.clipInfo(i).chain.some((c) => {
    const e = model.el(c);
    return e.style.overflowX !== 'visible' || /\b(paint|strict|content)\b/.test(e.style.contain);
  });
}

/** Nearest ancestor that generates a box (skips display:contents). */
function boxParent(model: SnapshotModel, i: number): number {
  let p = model.el(i).parent;
  while (p >= 0 && !model.el(p).flags.rendered) p = model.el(p).parent;
  return p;
}

export const viewportOverflowDetector: Detector = {
  category: 'viewport-overflow',
  description:
    'Content wider than the layout viewport: the page scrolls horizontally, or (with overflow-x hidden on the root) content is cut off at the edge. ' +
    'Reports the elements that escape their parent box (root causes), not every passenger inside them.',
  run({ model, t }) {
    const vp = model.viewport;
    const doc = model.snap.doc;
    const ov = model.viewportOverflow();
    const scrollable = doc.scrollWidth > vp.w + t.viewportOverflowMinPx && !hiddenOv(ov.x);
    const rootClips = hiddenOv(ov.x);
    const culprits: { i: number; right: number }[] = [];
    for (const e of model.els) {
      if (!e.flags.visible || e.tag === 'html' || e.tag === 'body' || e.flags.ignored) continue;
      if (model.clipInfo(e.i).fixedToViewport) continue;
      if (clippedOnX(model, e.i)) continue;
      const box = union([e.rect, ...(e.text ? e.text.rects : [])]);
      if (!box) continue;
      const r = right(box);
      if (r <= vp.w + t.viewportOverflowMinPx) continue;
      const fullyBeyond = box.x >= vp.w - 0.5;
      if (fullyBeyond && !scrollable) continue; // off-canvas content parked outside a clipping root
      const p = boxParent(model, e.i);
      if (p >= 0) {
        const pe = model.el(p);
        if (pe.tag !== 'html' && pe.tag !== 'body' && right(pe.rect) >= r - t.viewportOverflowMinPx) continue;
      }
      culprits.push({ i: e.i, right: r });
    }
    if (!scrollable && !(rootClips && culprits.length)) return [];
    culprits.sort((a, b) => b.right - a.right);
    const top = culprits.slice(0, 8);
    const overflowPx = scrollable ? doc.scrollWidth - vp.w : Math.max(...top.map((c) => c.right)) - vp.w;
    const variant = scrollable ? 'horizontal-scroll' : 'clipped-by-viewport';
    const culpritFacts = top.map(({ i, right: r }) => {
      const e = model.el(i);
      return {
        selector: e.selector,
        right: round2(r),
        beyondViewportPx: round2(r - vp.w),
        width: round2(e.rect.w),
        cssWidth: e.style.width,
        whiteSpace: e.style.whiteSpace,
        flexWrap: e.style.flexWrap,
        position: e.style.position,
        margin: e.style.margin,
      };
    });
    return [
      {
        category: 'viewport-overflow',
        key: `viewport-overflow|${variant}`,
        title: scrollable ? 'Page scrolls horizontally (content wider than the viewport)' : 'Content cut off at the viewport edge',
        description: scrollable
          ? `documentElement.scrollWidth is ${doc.scrollWidth}px but the viewport is ${vp.w}px wide (${round2(overflowPx)}px overflow).` +
            (top.length ? ` Elements escaping their parent: ${top.slice(0, 3).map((c) => model.label(c.i)).join(', ')}.` : ' No single element could be attributed.')
          : `The root clips horizontal overflow (overflow-x: ${ov.x}); ${top.length} element(s) extend past the ${vp.w}px viewport and cannot be scrolled into view: ` +
            top.slice(0, 3).map((c) => model.label(c.i)).join(', ') + '.',
        severity: overflowPx >= vp.w * 0.2 ? 'high' : 'medium',
        confidence: 0.8,
        maxStatus: 'verified',
        elements: top.map((c) => ({ index: c.i, role: 'subject' as const })),
        measurements: {
          variant,
          scrollWidth: doc.scrollWidth,
          clientWidth: vp.w,
          overflowPx: round2(overflowPx),
          rootOverflowX: ov.x,
          culprits: culpritFacts,
        },
        verify: scrollable ? [{ kind: 'hscroll' }] : [],
        consoleCheck:
          '(() => { const vw = document.documentElement.clientWidth; return { scrollWidth: document.documentElement.scrollWidth, clientWidth: vw, ' +
          'beyond: [...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > vw + 1).slice(0, 10) }; })()',
        notes: [],
      },
    ];
  },
};

export const containerOverflowDetector: Detector = {
  category: 'container-overflow',
  description:
    'In-flow content spilling outside a non-clipping container\'s border box (fixed-height cards, unbreakable text). ' +
    'Absolutely positioned/floated descendants are treated as intentionally placed.',
  run({ model, t }) {
    const claimed = new Set<number>();
    const out: Candidate[] = [];
    const containers = model.els
      .filter((c) => {
        const s = c.style;
        return (
          c.flags.visible && !c.flags.inline && !c.flags.srOnly && !c.flags.ignored &&
          c.tag !== 'html' && c.tag !== 'body' &&
          s.overflowX === 'visible' && s.overflowY === 'visible' && !c.flags.clips &&
          c.rect.w >= 4 && c.rect.h >= 4 &&
          (c.scroll.sh > c.scroll.ch + t.containerOverflowMinPx || c.scroll.sw > c.scroll.cw + t.containerOverflowMinPx)
        );
      })
      .sort((a, b) => b.depth - a.depth);
    for (const c of containers) {
      const spills: { i: number; rects: Rect[]; max: number; sides: ReturnType<typeof protrusion> }[] = [];
      const check = (i: number, rects: Rect[]): boolean => {
        if (!rects.length || claimed.has(i)) return false;
        const box = union(rects);
        if (!box) return false;
        const p = protrusion(c.rect, box);
        if (p.max < t.containerOverflowMinPx) return false;
        spills.push({ i, rects, max: p.max, sides: p });
        return true;
      };
      // Text directly inside the container (e.g. an unbreakable word).
      if (c.text && c.flags.hasDirectText) check(c.i, inkRects(model.contentRects(c.i, 'text')));
      const stack = [...(model.children[c.i] ?? [])];
      while (stack.length) {
        const d = stack.pop()!;
        const de = model.el(d);
        if (de.style.position === 'absolute' || de.style.position === 'fixed' || de.style.float !== 'none') continue;
        if (de.flags.popup || de.flags.topLayer) continue;
        const kind = model.contentKind(d);
        if (kind) {
          const rects = kind === 'text' ? inkRects(model.contentRects(d, kind)) : model.contentRects(d, kind);
          if (check(d, rects)) continue;
        }
        stack.push(...(model.children[d] ?? []));
      }
      if (!spills.length) continue;
      for (const s of spills) claimed.add(s.i);
      spills.sort((a, b) => b.max - a.max);
      const worst = spills[0]!;
      const region = subtractRegion(union(worst.rects)!, clipRegionFrom(c.rect, { x: true, y: true })).sort((a, b) => area(b) - area(a))[0];
      const maxSpill = worst.max;
      out.push({
        category: 'container-overflow',
        key: `container-overflow|${c.selector}`,
        title: 'Content spills out of its container',
        description:
          `${model.label(c.i)} is ${round2(c.rect.w)}×${round2(c.rect.h)}px but ${spills.length} content element(s) extend outside it; ` +
          `worst: ${model.label(worst.i)} by ${round2(maxSpill)}px ` +
          `(${Object.entries(worst.sides).filter(([k, v]) => k !== 'max' && v >= 1).map(([k, v]) => `${k} ${round2(v)}px`).join(', ')}).`,
        severity: maxSpill >= 8 ? 'medium' : 'low',
        confidence: 0.7,
        maxStatus: 'verified',
        elements: [
          { index: c.i, role: 'subject' },
          ...spills.slice(0, 6).filter((s) => s.i !== c.i).map((s) => ({ index: s.i, role: 'target' as const })),
        ],
        measurements: {
          container: {
            selector: c.selector,
            rect: roundRect(c.rect),
            height: c.style.height,
            maxHeight: c.style.maxHeight,
            width: c.style.width,
            scrollHeight: c.scroll.sh,
            clientHeight: c.scroll.ch,
            scrollWidth: c.scroll.sw,
            clientWidth: c.scroll.cw,
          },
          spilled: spills.slice(0, 6).map((s) => ({
            selector: model.el(s.i).selector,
            extent: roundRect(union(s.rects)!),
            outsideTop: round2(s.sides.top),
            outsideRight: round2(s.sides.right),
            outsideBottom: round2(s.sides.bottom),
            outsideLeft: round2(s.sides.left),
          })),
        },
        verify: region ? [{ kind: 'spill', container: c.i, element: worst.i, region }] : [],
        consoleCheck: `(() => { const c = document.querySelector(${cssq(c.selector)}); return { clientHeight: c.clientHeight, scrollHeight: c.scrollHeight, clientWidth: c.clientWidth, scrollWidth: c.scrollWidth }; })()`,
        notes: [],
      });
    }
    return out;
  },
};

export const offscreenTargetDetector: Detector = {
  category: 'offscreen-target',
  description:
    'Visible controls positioned (partly) where no scrolling can reach them: left of/above the document origin, past a clipped viewport, ' +
    'outside a fixed layer\'s viewport, or in the negative overflow of a scroll container. Skip-link patterns are verified by focusing.',
  run({ model, t }) {
    const out: Candidate[] = [];
    for (const e of model.els) {
      const f = e.flags;
      if (!f.interactive || !f.visible || f.srOnly || f.ariaHidden || f.inert || f.ignored) continue;
      const rects = e.fragments ?? [e.rect];
      const reach = model.reachableRegion(e.i);
      const h = hiddenOutside(rects, reach);
      if (Math.max(h.maxHiddenX, h.maxHiddenY) < t.offscreenMinPx || h.hiddenFraction < 0.1) continue;
      // Entirely hidden by an overflow:hidden ancestor anyway -> clipped-target owns it.
      const box = union(rects)!;
      if (!clipRect(box, model.hiddenClipRegion(e.i))) continue;
      const full = h.hiddenFraction >= 0.995;
      const dir: string[] = [];
      if (box.x < reach.x1 - 0.5) dir.push('left');
      if (right(box) > reach.x2 + 0.5) dir.push('right');
      if (box.y < reach.y1 - 0.5) dir.push('top');
      if (box.y + box.h > reach.y2 + 0.5) dir.push('bottom');
      const fixed = model.clipInfo(e.i).fixedToViewport;
      let severity: Candidate['severity'] = full ? 'high' : 'medium';
      if (f.interactiveSource === 'cursor' || f.disabled) severity = full ? 'medium' : 'low';
      const finite = (n: number): number | null => (Number.isFinite(n) ? round2(n) : null);
      out.push({
        category: 'offscreen-target',
        key: `offscreen-target|${e.selector}`,
        title: full ? 'Control is positioned off-screen and cannot be reached' : 'Control is partly off-screen and cannot be scrolled into view',
        description:
          `${model.label(e.i)} is ${Math.round(h.hiddenFraction * 100)}% outside the reachable area (${dir.join('/') || 'edge'}). ` +
          (fixed ? 'It is in a fixed-position layer, so scrolling the page cannot reveal it.' : 'Scrolling cannot reach content beyond the scroll origin or a clipped root.'),
        severity,
        confidence: 0.75,
        maxStatus: 'verified',
        // The parent box gives the screenshot context when the control itself cannot be captured.
        elements: [{ index: e.i, role: 'subject' }, ...(boxParent(model, e.i) >= 0 ? [{ index: boxParent(model, e.i), role: 'container' as const }] : [])],
        measurements: {
          rect: roundRect(e.rect),
          reachable: { x1: finite(reach.x1), x2: finite(reach.x2), y1: finite(reach.y1), y2: finite(reach.y2) },
          hiddenFraction: round2(h.hiddenFraction),
          direction: dir,
          fixedLayer: fixed,
          position: e.style.position,
          margin: e.style.margin,
          documentScrollWidth: model.snap.doc.scrollWidth,
          documentScrollHeight: model.snap.doc.scrollHeight,
        },
        verify: f.focusable ? [{ kind: 'focus', element: e.i }] : [],
        consoleCheck: `document.querySelector(${cssq(e.selector)}).getBoundingClientRect()`,
        notes: [],
      });
    }
    return out;
  },
};
