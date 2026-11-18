import {
  type ClipRegion,
  UNBOUNDED,
  clipRect,
  clipRegionFrom,
  intersectRegions,
} from './geometry.js';
import type { ElementRecord, PageSnapshot, Rect } from './snapshot-types.js';

export type LayerKind = 'flow' | 'fixed' | 'sticky' | 'popup' | 'modal' | 'top-layer';
export interface Layer {
  root: number;
  kind: LayerKind;
}

export type ContentKind = 'interactive' | 'text' | 'media';

const MEDIA_TAGS = new Set(['img', 'video', 'canvas', 'svg', 'iframe', 'object', 'embed', 'picture']);
const STATE_CLASS = /^(is-|has-)|active|selected|current|open|disabled|hover|focus|first|last|odd|even/i;

type Mode = 'normal' | 'abs' | 'fixed';
const modeOf = (position: string): Mode => (position === 'fixed' ? 'fixed' : position === 'absolute' ? 'abs' : 'normal');

const isHiddenOverflow = (o: string): boolean => o === 'hidden' || o === 'clip';
const isScrollOverflow = (o: string): boolean => o === 'auto' || o === 'scroll';

/**
 * Read-only model over a PageSnapshot: tree relations, CSS clipping chains
 * (containing-block aware), stacking layers and reachable regions.
 *
 * Clipping follows the CSS rule that `overflow` clips descendants whose
 * containing-block chain passes through the clipping box: an absolutely
 * positioned element escapes an overflow:hidden ancestor that sits between it
 * and its containing block, and a fixed element escapes everything except
 * ancestors that establish a containing block for fixed descendants.
 */
export class SnapshotModel {
  readonly els: ElementRecord[];
  readonly viewport: Rect;
  private readonly chainCache = new Map<number, { chain: number[]; fixedToViewport: boolean; cbs: number[] }>();
  private readonly layerCache = new Map<number, Layer>();
  readonly children: number[][];

  constructor(readonly snap: PageSnapshot) {
    this.els = snap.elements;
    this.viewport = { x: 0, y: 0, w: snap.viewport.clientWidth, h: snap.viewport.clientHeight };
    this.children = this.els.map(() => []);
    for (const e of this.els) if (e.parent >= 0) this.children[e.parent]!.push(e.i);
  }

  el(i: number): ElementRecord {
    const e = this.els[i];
    if (!e) throw new Error(`element index ${i} out of range`);
    return e;
  }

  /** True when `a` is a proper ancestor of `b` in the flat tree. */
  isAncestor(a: number, b: number): boolean {
    const da = this.el(a).depth;
    let p = this.el(b).parent;
    while (p >= 0) {
      if (p === a) return true;
      const pe = this.el(p);
      if (pe.depth <= da) return false;
      p = pe.parent;
    }
    return false;
  }

  related(a: number, b: number): boolean {
    return a === b || this.isAncestor(a, b) || this.isAncestor(b, a);
  }

  ancestors(i: number): number[] {
    const out: number[] = [];
    for (let p = this.el(i).parent; p >= 0; p = this.el(p).parent) out.push(p);
    return out;
  }

  private isRootish(e: ElementRecord): boolean {
    return e.tag === 'html' || e.tag === 'body';
  }

  /**
   * Clipping ancestors (nearest first), the containing-block chain, and whether
   * the element ultimately positions against the viewport (fixed / top layer).
   */
  clipInfo(i: number): { chain: number[]; fixedToViewport: boolean; cbs: number[] } {
    const cached = this.chainCache.get(i);
    if (cached) return cached;
    const self = this.el(i);
    const chain: number[] = [];
    const cbs: number[] = [];
    let fixedToViewport = false;
    if (self.flags.topLayer) {
      fixedToViewport = true;
    } else {
      let mode = modeOf(self.style.position);
      let p = self.parent;
      while (p >= 0) {
        const pe = this.el(p);
        const isCB =
          mode === 'normal' ? true : mode === 'abs' ? pe.style.position !== 'static' || pe.flags.fixedCB : pe.flags.fixedCB;
        if (isCB) {
          cbs.push(p);
          if (pe.flags.rendered && pe.flags.clips && !this.isRootish(pe)) chain.push(p);
          if (pe.flags.topLayer) {
            mode = 'fixed';
            break;
          }
          mode = modeOf(pe.style.position);
        }
        p = pe.parent;
      }
      fixedToViewport = mode === 'fixed';
    }
    const info = { chain, fixedToViewport, cbs };
    this.chainCache.set(i, info);
    return info;
  }

  /** Clip region a clipper imposes, restricted to the requested overflow kinds. */
  clipperRegion(c: number, kinds: { hidden: boolean; scroll: boolean }): ClipRegion {
    const e = this.el(c);
    const paint = /\b(paint|strict|content)\b/.test(e.style.contain);
    const axis = (o: string): boolean =>
      paint || (kinds.hidden && isHiddenOverflow(o)) || (kinds.scroll && isScrollOverflow(o));
    return clipRegionFrom(e.clipBox, { x: axis(e.style.overflowX), y: axis(e.style.overflowY) });
  }

  /** Region where element i's own content may paint, after ancestor (and optionally self) clipping. */
  paintRegion(i: number, opts: { includeSelf?: boolean; hidden?: boolean; scroll?: boolean; viewportForFixed?: boolean } = {}): ClipRegion {
    const kinds = { hidden: opts.hidden ?? true, scroll: opts.scroll ?? true };
    const info = this.clipInfo(i);
    let region = UNBOUNDED;
    if (opts.includeSelf && this.el(i).flags.clips) region = intersectRegions(region, this.clipperRegion(i, kinds));
    for (const c of info.chain) region = intersectRegions(region, this.clipperRegion(c, kinds));
    if ((opts.viewportForFixed ?? true) && info.fixedToViewport) {
      region = intersectRegions(region, clipRegionFrom(this.viewport, { x: true, y: true }));
    }
    return region;
  }

  /** Border box after all ancestor clipping (hidden + scroll) and viewport clipping for fixed elements. */
  visibleRect(i: number): Rect | null {
    return clipRect(this.el(i).rect, this.paintRegion(i));
  }

  /** Clip region from overflow:hidden/clip ancestors only (content there is not reachable by scrolling). */
  hiddenClipRegion(i: number, includeSelf = false): ClipRegion {
    return this.paintRegion(i, { includeSelf, hidden: true, scroll: false, viewportForFixed: false });
  }

  /** The clipper nearest to i that actually cuts `r` (hidden/clip kinds only), or -1. */
  nearestHiddenClipperCutting(i: number, r: Rect, includeSelf = false): number {
    const cands = [...(includeSelf && this.el(i).flags.clips ? [i] : []), ...this.clipInfo(i).chain];
    for (const c of cands) {
      const region = this.clipperRegion(c, { hidden: true, scroll: false });
      const vis = clipRect(r, region);
      if (!vis || vis.w < r.w - 0.5 || vis.h < r.h - 0.5) return c;
    }
    return -1;
  }

  /** Effective overflow of the viewport (html, or body propagated when html is visible). */
  viewportOverflow(): { x: string; y: string } {
    const d = this.snap.doc;
    return {
      x: d.rootOverflowX !== 'visible' ? d.rootOverflowX : d.bodyOverflowX,
      y: d.rootOverflowY !== 'visible' ? d.rootOverflowY : d.bodyOverflowY,
    };
  }

  /**
   * Region a user can bring into view by scrolling: the viewport for fixed
   * content, otherwise the document scroll area (unless the root clips), further
   * limited by the scroll extents of scrolling ancestors. Content to the left of
   * / above a scroll origin is unreachable.
   */
  reachableRegion(i: number): ClipRegion {
    const info = this.clipInfo(i);
    const vp = this.viewport;
    // On an axis where a scrolling ancestor exists, that ancestor's scroll extents decide
    // reachability; the page/viewport bound applies to the ancestor itself, not to its content.
    let innerScrollX = false;
    let innerScrollY = false;
    for (const c of info.chain) {
      const e = this.el(c);
      innerScrollX ||= isScrollOverflow(e.style.overflowX);
      innerScrollY ||= isScrollOverflow(e.style.overflowY);
    }
    let region: ClipRegion;
    if (info.fixedToViewport) {
      region = clipRegionFrom(vp, { x: true, y: true });
    } else {
      const ov = this.viewportOverflow();
      const rtl = this.snap.doc.dir === 'rtl';
      const sw = this.snap.doc.scrollWidth;
      const sh = this.snap.doc.scrollHeight;
      const xClip = isHiddenOverflow(ov.x);
      const yClip = isHiddenOverflow(ov.y);
      region = {
        x1: xClip ? 0 : rtl ? vp.w - sw : 0,
        x2: xClip ? vp.w : rtl ? vp.w : Math.max(sw, vp.w),
        y1: 0,
        y2: yClip ? vp.h : Math.max(sh, vp.h),
      };
    }
    if (innerScrollX) region = { ...region, x1: -Infinity, x2: Infinity };
    if (innerScrollY) region = { ...region, y1: -Infinity, y2: Infinity };
    for (const c of info.chain) {
      const e = this.el(c);
      const sx = isScrollOverflow(e.style.overflowX);
      const sy = isScrollOverflow(e.style.overflowY);
      if (!sx && !sy) continue;
      const x1 = e.clipBox.x - e.scroll.sl;
      const y1 = e.clipBox.y - e.scroll.st;
      region = intersectRegions(region, {
        x1: sx ? x1 : -Infinity,
        x2: sx ? x1 + e.scroll.sw : Infinity,
        y1: sy ? y1 : -Infinity,
        y2: sy ? y1 + e.scroll.sh : Infinity,
      });
    }
    return region;
  }

  /** Nearest ancestor-or-self that defines a non-flow layer (top layer, modal, popup, fixed, sticky). */
  layer(i: number): Layer {
    const cached = this.layerCache.get(i);
    if (cached) return cached;
    const e = this.el(i);
    let result: Layer;
    if (e.flags.modal) result = { root: i, kind: 'modal' };
    else if (e.flags.topLayer) result = { root: i, kind: 'top-layer' };
    else if (e.flags.popup) result = { root: i, kind: 'popup' };
    else if (e.style.position === 'fixed' && this.clipInfo(i).fixedToViewport) result = { root: i, kind: 'fixed' };
    else if (e.style.position === 'sticky') result = { root: i, kind: 'sticky' };
    else if (e.parent >= 0) result = this.layer(e.parent);
    else result = { root: -1, kind: 'flow' };
    this.layerCache.set(i, result);
    return result;
  }

  /** Whether i sits inside an overlay layer (popup, modal, top layer). */
  inOverlay(i: number): boolean {
    const k = this.layer(i).kind;
    return k === 'popup' || k === 'modal' || k === 'top-layer';
  }

  isMedia(i: number): boolean {
    return MEDIA_TAGS.has(this.el(i).tag);
  }

  /** What kind of user-perceivable content an element is, if any. */
  contentKind(i: number): ContentKind | null {
    const e = this.el(i);
    const f = e.flags;
    if (!f.visible || f.srOnly || f.ignored) return null;
    if (f.interactive && f.interactiveSource === 'semantic') return 'interactive';
    if (this.isMedia(i)) return 'media';
    if (f.hasDirectText && e.text) return 'text';
    if (f.interactive) return 'interactive';
    return null;
  }

  /** Painted rects of an element's content, clipped to where it can actually be seen. */
  contentRects(i: number, kind = this.contentKind(i)): Rect[] {
    const e = this.el(i);
    if (!kind) return [];
    const raw = kind === 'text' ? (e.text?.rects ?? []) : (e.fragments ?? [e.rect]);
    const region = this.paintRegion(i, { includeSelf: kind === 'text' });
    const out: Rect[] = [];
    for (const r of raw) {
      const c = clipRect(r, region);
      if (c) out.push(c);
    }
    return out;
  }

  /** Grouping signature for "items of the same kind" (alignment/spacing). */
  signature(i: number): string {
    const e = this.el(i);
    const classes = e.classes
      .split(' ')
      .filter((c) => c && !STATE_CLASS.test(c))
      .sort()
      .join('.');
    return `${e.tag}|${e.role ?? ''}|${classes}`;
  }

  /** Elements matched by a predicate, by index. */
  where(pred: (e: ElementRecord) => boolean): number[] {
    const out: number[] = [];
    for (const e of this.els) if (pred(e)) out.push(e.i);
    return out;
  }

  /** Short human label: selector plus text/name snippet. */
  label(i: number): string {
    const e = this.el(i);
    const t = (e.name || e.textSnippet || '').slice(0, 40);
    return t ? `${e.selector} ("${t}")` : e.selector;
  }
}
