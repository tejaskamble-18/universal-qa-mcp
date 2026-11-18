import type { ElementFlags, ElementRecord, ElementStyle, PageSnapshot, Rect } from '../../src/engine/snapshot-types.js';

type Spec = {
  parent: number;
  tag?: string;
  id?: string;
  classes?: string;
  rect: Rect;
  style?: Partial<ElementStyle>;
  flags?: Partial<ElementFlags>;
  text?: Rect[];
  clipBox?: Rect;
  scroll?: Partial<ElementRecord['scroll']>;
  role?: string;
};

const STYLE: ElementStyle = {
  display: 'block',
  visibility: 'visible',
  opacity: 1,
  position: 'static',
  zIndex: 'auto',
  overflowX: 'visible',
  overflowY: 'visible',
  textOverflow: 'clip',
  whiteSpace: 'normal',
  lineClamp: 'none',
  pointerEvents: 'auto',
  transform: false,
  float: 'none',
  flexDirection: 'row',
  flexWrap: 'nowrap',
  justifyContent: 'normal',
  alignItems: 'normal',
  rowGap: 'normal',
  columnGap: 'normal',
  margin: [0, 0, 0, 0],
  padding: [0, 0, 0, 0],
  border: [0, 0, 0, 0],
  fontSize: 16,
  lineHeight: 'normal',
  width: 'auto',
  height: 'auto',
  maxHeight: 'none',
  cursor: 'auto',
  contain: 'none',
};

const FLAGS: ElementFlags = {
  rendered: true,
  visible: true,
  interactive: false,
  interactiveSource: null,
  focusable: false,
  disabled: false,
  ariaHidden: false,
  inert: false,
  srOnly: false,
  fixedCB: false,
  clips: false,
  scrollContainer: false,
  replaced: false,
  inShadow: false,
  hasDirectText: false,
  popup: false,
  modal: false,
  inline: false,
  topLayer: false,
  ignored: false,
};

/**
 * Build a PageSnapshot from compact specs. Index 0 is always <html>, 1 is
 * <body>; specs are appended from index 2 and refer to parents by index.
 */
export function synth(specs: Spec[], viewport = { w: 1000, h: 800 }, doc: Partial<PageSnapshot['doc']> = {}): PageSnapshot {
  const all: Spec[] = [
    { parent: -1, tag: 'html', rect: { x: 0, y: 0, w: viewport.w, h: viewport.h } },
    { parent: 0, tag: 'body', rect: { x: 0, y: 0, w: viewport.w, h: viewport.h } },
    ...specs,
  ];
  const elements: ElementRecord[] = [];
  all.forEach((s, i) => {
    const style = { ...STYLE, ...s.style };
    const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible';
    const flags: ElementFlags = {
      ...FLAGS,
      clips,
      scrollContainer: /auto|scroll/.test(`${style.overflowX} ${style.overflowY}`),
      hasDirectText: !!s.text?.length,
      ...s.flags,
    };
    const tag = s.tag ?? 'div';
    const parentDepth = s.parent >= 0 ? elements[s.parent]!.depth : -1;
    elements.push({
      i,
      parent: s.parent,
      depth: parentDepth + 1,
      tag,
      selector: s.id ? `#${s.id}` : `${tag}:nth-of-type(${i})`,
      id: s.id ?? null,
      classes: s.classes ?? '',
      role: s.role ?? null,
      name: '',
      textSnippet: s.text?.length ? 'text' : '',
      attrs: {},
      rect: s.rect,
      fragments: null,
      clipBox: s.clipBox ?? s.rect,
      style,
      scroll: { sw: s.rect.w, sh: s.rect.h, cw: s.rect.w, ch: s.rect.h, sl: 0, st: 0, ...s.scroll },
      flags,
      text: s.text?.length
        ? {
            rects: s.text,
            union: s.text.reduce((u, r) => ({
              x: Math.min(u.x, r.x),
              y: Math.min(u.y, r.y),
              w: Math.max(u.x + u.w, r.x + r.w) - Math.min(u.x, r.x),
              h: Math.max(u.y + u.h, r.y + r.h) - Math.min(u.y, r.y),
            })),
            lines: s.text.length,
            length: 10,
          }
        : null,
      trigger: -1,
      labelControl: -1,
      probes: [],
      textProbes: [],
    });
  });
  return {
    url: 'about:synthetic',
    title: 'synthetic',
    collectedAt: new Date(0).toISOString(),
    viewport: { innerWidth: viewport.w, innerHeight: viewport.h, clientWidth: viewport.w, clientHeight: viewport.h, devicePixelRatio: 1 },
    doc: {
      scrollWidth: viewport.w,
      scrollHeight: viewport.h,
      rootOverflowX: 'visible',
      rootOverflowY: 'visible',
      bodyOverflowX: 'visible',
      bodyOverflowY: 'visible',
      dir: 'ltr',
      ...doc,
    },
    elements,
    unrenderedControls: [],
    disclosureControls: [],
    stats: {
      domElements: elements.length,
      recorded: elements.length,
      truncated: false,
      openShadowRoots: 0,
      iframes: 0,
      hitProbedElements: 0,
      scrolledProbes: 0,
      textProbedElements: 0,
      collectMs: 0,
    },
  };
}

export const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
