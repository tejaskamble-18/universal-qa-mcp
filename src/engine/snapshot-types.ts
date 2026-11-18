/**
 * Data contract produced by the in-page collector (src/inpage/collector.js)
 * and consumed by the Node-side model and detectors.
 *
 * All rects are CSS pixels in viewport coordinates captured with the window
 * scrolled to (0, 0). Because the window is at the origin, these are also
 * document coordinates for non-fixed elements.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Overflow = 'visible' | 'hidden' | 'clip' | 'auto' | 'scroll';

export interface ElementStyle {
  display: string;
  visibility: string;
  opacity: number;
  position: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
  zIndex: string;
  overflowX: Overflow;
  overflowY: Overflow;
  textOverflow: string;
  whiteSpace: string;
  lineClamp: string;
  pointerEvents: string;
  transform: boolean;
  float: string;
  flexDirection: string;
  flexWrap: string;
  justifyContent: string;
  alignItems: string;
  rowGap: string;
  columnGap: string;
  /** top, right, bottom, left */
  margin: [number, number, number, number];
  padding: [number, number, number, number];
  border: [number, number, number, number];
  fontSize: number;
  lineHeight: string;
  width: string;
  height: string;
  maxHeight: string;
  cursor: string;
  contain: string;
}

export interface ElementFlags {
  /** Element generates at least one layout box. */
  rendered: boolean;
  /** Rendered, visibility:visible, non-zero opacity (incl. ancestors), non-zero size. */
  visible: boolean;
  interactive: boolean;
  /** How `interactive` was decided: semantic HTML/ARIA, or the cursor:pointer heuristic. */
  interactiveSource: 'semantic' | 'cursor' | null;
  focusable: boolean;
  disabled: boolean;
  /** Inside an aria-hidden="true" subtree (or self). */
  ariaHidden: boolean;
  /** Inside an inert subtree, or outside an open modal <dialog>. */
  inert: boolean;
  /** Visually-hidden (screen-reader-only) clip pattern on self or an ancestor. */
  srOnly: boolean;
  /** Establishes a containing block for position:fixed descendants (transform, filter, contain...). */
  fixedCB: boolean;
  /** This element clips its descendants (overflow != visible, or contain: paint). */
  clips: boolean;
  /** Overflow auto/scroll on at least one axis. */
  scrollContainer: boolean;
  replaced: boolean;
  inShadow: boolean;
  hasDirectText: boolean;
  popup: boolean;
  modal: boolean;
  /** Has inline formatting (display: inline / contents). */
  inline: boolean;
  /** Rendered in the browser top layer (modal <dialog>, open popover): escapes all ancestor clipping. */
  topLayer: boolean;
  /** Matched a caller-supplied ignore selector (self or ancestor). */
  ignored: boolean;
}

export interface TextGeometry {
  /** Line-box rects of the element's direct text nodes (capped). */
  rects: Rect[];
  union: Rect;
  lines: number;
  length: number;
}

export interface HitSample {
  /** Fractional position inside the element's border box that was probed. */
  fx: number;
  fy: number;
  /** Viewport point probed. */
  x: number;
  y: number;
  /** Probe point lay outside the viewport and was not tested. */
  outside: boolean;
  /** Topmost hit-testable element index; -1 if nothing; -2 if not in the snapshot. */
  top: number;
  topSelector: string | null;
  /** Topmost element is the target, a descendant, or its associated label. */
  ok: boolean;
}

export interface HitProbe {
  /** 'initial' = probed at scroll (0,0); 'scrolled' = after scrollIntoView({block:'center'}). */
  mode: 'initial' | 'scrolled';
  scrollX: number;
  scrollY: number;
  samples: HitSample[];
}

/** Hit test at a point on one of an element's text lines (document coordinates). */
export interface TextProbe {
  /** Document coordinates of the probe point (== snapshot coordinates for non-fixed text). */
  x: number;
  y: number;
  /** Window scrollY at which the point was probed. */
  sy: number;
  top: number;
  topSelector: string | null;
  /** Topmost element is the text element itself, a descendant or an ancestor. */
  ok: boolean;
}

export interface ElementRecord {
  i: number;
  /** Flat-tree parent index (slot or shadow host aware); -1 for the root. */
  parent: number;
  depth: number;
  tag: string;
  selector: string;
  id: string | null;
  classes: string;
  role: string | null;
  name: string;
  textSnippet: string;
  attrs: {
    type?: string;
    href?: string;
    ariaExpanded?: string;
    ariaControls?: string;
    ariaHaspopup?: string;
    ariaRoledescription?: string;
    title?: string;
    forId?: string;
  };
  rect: Rect;
  /** Per-line fragments for inline elements that wrap (getClientRects), capped. */
  fragments: Rect[] | null;
  /** Inner (client) box used as the clip edge when this element clips. */
  clipBox: Rect;
  style: ElementStyle;
  scroll: { sw: number; sh: number; cw: number; ch: number; sl: number; st: number };
  flags: ElementFlags;
  text: TextGeometry | null;
  /** Index of the popup's trigger (aria-controls / popovertarget), if this is a popup. */
  trigger: number;
  /** Index of the form control this <label> targets. */
  labelControl: number;
  probes: HitProbe[];
  /** Occlusion probes along non-interactive text lines. */
  textProbes: TextProbe[];
}

export interface UnrenderedControl {
  selector: string;
  tag: string;
  name: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  collectedAt: string;
  viewport: {
    innerWidth: number;
    innerHeight: number;
    clientWidth: number;
    clientHeight: number;
    devicePixelRatio: number;
  };
  doc: {
    scrollWidth: number;
    scrollHeight: number;
    rootOverflowX: Overflow;
    rootOverflowY: Overflow;
    bodyOverflowX: Overflow;
    bodyOverflowY: Overflow;
    dir: string;
  };
  elements: ElementRecord[];
  /** Interactive elements present in the DOM but not rendered (display:none etc.). */
  unrenderedControls: UnrenderedControl[];
  /** Selectors of rendered, visible disclosure controls (aria-expanded, summary, aria-haspopup). */
  disclosureControls: string[];
  stats: {
    domElements: number;
    recorded: number;
    truncated: boolean;
    openShadowRoots: number;
    iframes: number;
    hitProbedElements: number;
    scrolledProbes: number;
    textProbedElements: number;
    collectMs: number;
  };
}

export interface CollectOptions {
  maxElements: number;
  maxHitElements: number;
  maxScrolledProbes: number;
  /** Text elements probed for occlusion, and how many viewport-height scroll steps to probe through. */
  maxTextProbeElements: number;
  maxTextScrollSteps: number;
  ignoreSelectors: string[];
}
