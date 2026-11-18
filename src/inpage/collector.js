// @ts-check
/**
 * Universal QA MCP — in-page geometry collector.
 *
 * Evaluated inside the target page's main frame (Playwright `page.evaluate(source)`).
 * It is plain JavaScript on purpose: the source is injected verbatim, so it must be
 * self-contained and must not depend on any transpiler helpers.
 *
 * It installs `window.__uqa` with:
 *   collect(opts)            -> PageSnapshot (see src/engine/snapshot-types.ts)
 *   remeasure(indices)       -> current rects of recorded elements
 *   reveal(indices)          -> scrolls the window so the elements are in view, returns rects
 *   stackAt(x, y)            -> element indices stacked at a viewport point
 *   override(i, prop, val)   -> temporary !important inline style (verification only)
 *   restore()                -> undo every override
 *   focusProbe(i)            -> focus an element, measure, restore focus + scroll
 *   maxScrollX()             -> how far the window can actually scroll horizontally
 *
 * Read-only contract: collect() only reads layout. The verifier's probes scroll, set
 * temporary inline styles or move focus, and always restore the previous state.
 */
(() => {
  const VERSION = 1;
  const w = /** @type {any} */ (window);
  if (w.__uqa && w.__uqa.version === VERSION) return true;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE',
    'BASE', 'BR', 'WBR', 'PARAM', 'SOURCE', 'TRACK', 'DATALIST',
  ]);
  const REPLACED = new Set([
    'IMG', 'VIDEO', 'CANVAS', 'svg', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'SELECT',
    'TEXTAREA', 'METER', 'PROGRESS', 'AUDIO',
  ]);
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem',
  ]);
  const INTERACTIVE_SELECTOR =
    'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,' +
    '[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"],' +
    '[tabindex]:not([tabindex="-1"]),[contenteditable="true"],[contenteditable=""]';
  const SAMPLE_FRACTIONS = [0.2, 0.5, 0.8];
  const IDENT = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/;

  /** @type {any[]} Recorded elements by index (callers only index with recorded indices). */
  let els = [];
  /** @type {Map<Element, number>} */
  let indexOf = new Map();
  /** @type {Map<string, {el: HTMLElement, prop: string, value: string, priority: string, hadStyle: boolean}>} */
  const overrides = new Map();

  const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
  /** @param {DOMRect | {left:number, top:number, width:number, height:number}} r */
  const toRect = (r) => ({ x: r2(r.left), y: r2(r.top), w: r2(r.width), h: r2(r.height) });

  /** Flat-tree parent: slot for slotted nodes, host for shadow-root children. */
  function flatParent(/** @type {Node} */ node) {
    const el = /** @type {any} */ (node);
    if (el.assignedSlot) return el.assignedSlot;
    const p = node.parentNode;
    if (p && p.nodeType === 11 && /** @type {any} */ (p).host) return /** @type {any} */ (p).host;
    return p && p.nodeType === 1 ? p : null;
  }

  function composedContains(/** @type {Element} */ ancestor, /** @type {Node|null} */ node) {
    for (let n = node; n; n = flatParent(n)) if (n === ancestor) return true;
    return false;
  }

  function byId(/** @type {Element} */ from, /** @type {string} */ id) {
    const root = /** @type {any} */ (from.getRootNode());
    return (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
  }

  function px(/** @type {string} */ v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  // ---------------------------------------------------------------- selectors
  /** @type {Map<Node, Map<string, number>>} */
  let idCounts = new Map();
  /** @type {Map<Element, string>} */
  let selectorCache = new Map();

  function idCount(/** @type {Node} */ root, /** @type {string} */ id) {
    let m = idCounts.get(root);
    if (!m) {
      m = new Map();
      for (const e of /** @type {any} */ (root).querySelectorAll('[id]')) m.set(e.id, (m.get(e.id) || 0) + 1);
      idCounts.set(root, m);
    }
    return m.get(id) || 0;
  }

  function selectorPart(/** @type {Element} */ el) {
    let part = el.localName;
    const classes = Array.from(el.classList).filter((c) => IDENT.test(c) && c.length < 32).slice(0, 2);
    for (const c of classes) part += '.' + CSS.escape(c);
    const parent = el.parentElement || /** @type {any} */ (el.parentNode);
    if (parent && parent.children) {
      let n = 0;
      let pos = 0;
      for (const sib of parent.children) {
        if (sib.localName === el.localName) {
          n++;
          if (sib === el) pos = n;
        }
      }
      if (n > 1) part += `:nth-of-type(${pos})`;
    }
    return part;
  }

  /** @returns {string} */
  function selectorOf(/** @type {Element} */ el) {
    const cached = selectorCache.get(el);
    if (cached) return cached;
    const root = el.getRootNode();
    let sel;
    if (el.id && idCount(root, el.id) === 1) {
      sel = '#' + CSS.escape(el.id);
    } else if (el === document.documentElement) {
      sel = 'html';
    } else if (el === document.body) {
      sel = 'body';
    } else {
      const parent = el.parentElement;
      const part = selectorPart(el);
      sel = parent ? `${selectorOf(parent)} > ${part}` : part;
    }
    if (root !== document && /** @type {any} */ (root).host && !el.parentElement) {
      // Top-level element inside a shadow root: chain from the host (Playwright `>>`).
      sel = `${selectorOf(/** @type {any} */ (root).host)} >> ${sel}`;
    }
    selectorCache.set(el, sel);
    return sel;
  }

  // ---------------------------------------------------------------- semantics
  function accessibleName(/** @type {Element} */ el) {
    const e = /** @type {any} */ (el);
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim().slice(0, 80);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => byId(el, id)?.textContent || '').join(' ').trim();
      if (t) return t.slice(0, 80);
    }
    if (e.labels && e.labels.length) {
      const t = (e.labels[0].textContent || '').trim();
      if (t) return t.slice(0, 80);
    }
    for (const a of ['alt', 'title', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v && v.trim()) return v.trim().slice(0, 80);
    }
    if (el.tagName === 'INPUT' && /^(submit|button|reset)$/.test(e.type) && e.value) return String(e.value).slice(0, 80);
    return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function isSemanticInteractive(/** @type {Element} */ el) {
    const tag = el.tagName;
    if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href');
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
    if (tag === 'INPUT') return /** @type {HTMLInputElement} */ (el).type !== 'hidden';
    if ((tag === 'VIDEO' || tag === 'AUDIO') && el.hasAttribute('controls')) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    const ce = el.getAttribute('contenteditable');
    if (ce === '' || ce === 'true') return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0) return true;
    return false;
  }

  function isSrOnly(/** @type {CSSStyleDeclaration} */ cs, /** @type {DOMRect} */ r) {
    if (cs.clip && cs.clip !== 'auto' && /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(cs.clip)) return true;
    if (/inset\(\s*(50|100)%|circle\(\s*0/.test(cs.clipPath)) return true;
    if (r.width <= 1.5 && r.height <= 1.5 && cs.overflow !== 'visible') return true;
    return false;
  }

  function establishesFixedCB(/** @type {CSSStyleDeclaration} */ cs) {
    return (
      cs.transform !== 'none' ||
      cs.perspective !== 'none' ||
      cs.filter !== 'none' ||
      (cs.backdropFilter && cs.backdropFilter !== 'none') ||
      /\b(paint|layout|strict|content)\b/.test(cs.contain) ||
      /\b(transform|perspective|filter)\b/.test(cs.willChange) ||
      (cs.containerType && cs.containerType !== 'normal')
    );
  }

  function isPopupEl(
    /** @type {Element} */ el,
    /** @type {CSSStyleDeclaration} */ cs,
    /** @type {Map<Element, Element>} */ triggerFor,
  ) {
    const role = el.getAttribute('role');
    const positioned = cs.position === 'absolute' || cs.position === 'fixed';
    if (el.tagName === 'DIALOG' && /** @type {any} */ (el).open) return true;
    if (el.getAttribute('aria-modal') === 'true') return true;
    if (role === 'dialog' || role === 'alertdialog') return positioned;
    try {
      if (el.hasAttribute('popover') && el.matches(':popover-open')) return true;
    } catch {}
    if (role === 'menu' || role === 'listbox' || role === 'tooltip') return positioned || triggerFor.has(el);
    if (triggerFor.has(el)) return positioned;
    return false;
  }

  function inTopLayer(/** @type {Element} */ el) {
    try {
      if (el.tagName === 'DIALOG' && el.matches(':modal')) return true;
      if (el.hasAttribute('popover') && el.matches(':popover-open')) return true;
    } catch {}
    return false;
  }

  function textGeometry(/** @type {Element} */ el) {
    /** @type {{x:number,y:number,w:number,h:number}[]} */
    const rects = [];
    let length = 0;
    let snippet = '';
    for (const n of el.childNodes) {
      if (n.nodeType !== 3) continue;
      const t = n.textContent || '';
      if (!t.trim()) continue;
      length += t.trim().length;
      if (snippet.length < 80) snippet += (snippet ? ' ' : '') + t.replace(/\s+/g, ' ').trim();
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const cr of range.getClientRects()) {
        if (cr.width > 0.5 && cr.height > 0.5 && rects.length < 40) rects.push(toRect(cr));
      }
    }
    if (!rects.length) return { geom: null, snippet: snippet.slice(0, 80) };
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const tops = new Set();
    for (const r of rects) {
      x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
      x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
      tops.add(Math.round(r.y));
    }
    return {
      geom: { rects, union: { x: r2(x1), y: r2(y1), w: r2(x2 - x1), h: r2(y2 - y1) }, lines: tops.size, length },
      snippet: snippet.slice(0, 80),
    };
  }

  // ---------------------------------------------------------------- hit testing
  function deepElementFromPoint(/** @type {number} */ x, /** @type {number} */ y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function indexForNode(/** @type {Element|null} */ node) {
    for (let n = /** @type {Node|null} */ (node); n; n = flatParent(n)) {
      const i = indexOf.get(/** @type {Element} */ (n));
      if (i !== undefined) return i;
    }
    return -2;
  }

  function hitOk(/** @type {Element} */ target, /** @type {Element|null} */ top) {
    if (!top) return false;
    if (composedContains(target, top)) return true;
    const label = top.closest ? top.closest('label') : null;
    if (label && /** @type {any} */ (label).control === target) return true;
    if (target.tagName === 'LABEL' && /** @type {any} */ (target).control === top) return true;
    return false;
  }

  function probe(/** @type {Element} */ el, /** @type {'initial'|'scrolled'} */ mode) {
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const fr = r.width < 10 || r.height < 10 ? [0.5] : SAMPLE_FRACTIONS;
    const samples = [];
    for (const fy of fr) {
      for (const fx of fr) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        const outside = x < 0 || y < 0 || x >= vw || y >= vh;
        let top = -1;
        let topSelector = null;
        let ok = false;
        if (!outside) {
          const hit = deepElementFromPoint(x, y);
          ok = hitOk(el, hit);
          top = hit ? indexForNode(hit) : -1;
          if (hit && !ok) topSelector = selectorOf(hit);
        }
        samples.push({ fx, fy, x: r2(x), y: r2(y), outside, top, topSelector, ok });
      }
    }
    return { mode, scrollX: window.scrollX, scrollY: window.scrollY, samples };
  }

  // ---------------------------------------------------------------- collect
  /** @param {{maxElements:number, maxHitElements:number, maxScrolledProbes:number, maxTextProbeElements:number, maxTextScrollSteps:number, ignoreSelectors:string[]}} opts */
  function collect(opts) {
    const t0 = performance.now();
    els = [];
    indexOf = new Map();
    idCounts = new Map();
    selectorCache = new Map();
    window.scrollTo(0, 0);
    const de = document.documentElement;
    const body = document.body;

    /** @type {Map<Element, Element>} */
    const triggerFor = new Map();
    for (const t of document.querySelectorAll('[aria-controls]')) {
      if (t.getAttribute('aria-expanded') !== 'true') continue;
      for (const id of (t.getAttribute('aria-controls') || '').split(/\s+/)) {
        const p = id && byId(t, id);
        if (p) triggerFor.set(p, t);
      }
    }
    for (const t of document.querySelectorAll('[popovertarget]')) {
      const p = byId(t, t.getAttribute('popovertarget') || '');
      try {
        if (p && p.matches(':popover-open')) triggerFor.set(p, t);
      } catch {}
    }
    for (const p of document.querySelectorAll('[role="menu"][aria-labelledby],[role="listbox"][aria-labelledby]')) {
      if (triggerFor.has(p)) continue;
      const t = byId(p, (p.getAttribute('aria-labelledby') || '').split(/\s+/)[0] || '');
      if (t && (t.hasAttribute('aria-haspopup') || t.hasAttribute('aria-expanded'))) triggerFor.set(p, t);
    }

    const ignore = (opts.ignoreSelectors || []).filter(Boolean).join(',');
    /** @type {any[]} */
    const recs = [];
    let truncated = false;
    let shadowRoots = 0;
    let iframes = 0;

    /** @type {{el: Element, parent: number, depth: number, inShadow: boolean}[]} */
    const stack = [{ el: de, parent: -1, depth: 0, inShadow: false }];
    while (stack.length) {
      const item = /** @type {{el: Element, parent: number, depth: number, inShadow: boolean}} */ (stack.pop());
      const el = item.el;
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (recs.length >= opts.maxElements) {
        truncated = true;
        continue;
      }
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      const parentRec = item.parent >= 0 ? recs[item.parent] : null;
      const i = recs.length;
      els.push(el);
      indexOf.set(el, i);

      const r = el.getBoundingClientRect();
      const clientRects = el.getClientRects();
      const rendered = clientRects.length > 0;
      const inline = cs.display === 'inline' || cs.display === 'contents';
      let visible = rendered && cs.visibility === 'visible' && r.width > 0 && r.height > 0;
      if (visible && typeof /** @type {any} */ (el).checkVisibility === 'function') {
        visible = /** @type {any} */ (el).checkVisibility({
          checkOpacity: true, opacityProperty: true, checkVisibilityCSS: true,
          visibilityProperty: true, contentVisibilityAuto: true,
        });
      }
      const semantic = isSemanticInteractive(el);
      const inInteractive = parentRec ? parentRec._inInteractive : false;
      const parentCursor = parentRec ? parentRec.style.cursor : 'auto';
      const cursorHint = !semantic && !inInteractive && cs.cursor === 'pointer' && parentCursor !== 'pointer' &&
        el !== body && el !== de;
      const interactive = semantic || cursorHint;
      const disabled = /** @type {any} */ (el).disabled === true || el.getAttribute('aria-disabled') === 'true';
      const ariaHidden = (parentRec ? parentRec.flags.ariaHidden : false) || el.getAttribute('aria-hidden') === 'true';
      const inert = (parentRec ? parentRec.flags.inert : false) || el.hasAttribute('inert');
      const srOnly = (parentRec ? parentRec.flags.srOnly : false) || isSrOnly(cs, r);
      const ox = /** @type {any} */ (cs.overflowX);
      const oy = /** @type {any} */ (cs.overflowY);
      const containPaint = /\b(paint|strict|content)\b/.test(cs.contain);
      const clips = !inline && (ox !== 'visible' || oy !== 'visible' || containPaint);
      const tg = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ? null : textGeometry(el);
      const popup = isPopupEl(el, cs, triggerFor);
      const modal = popup && (
        (el.tagName === 'DIALOG' && (() => { try { return el.matches(':modal'); } catch { return false; } })()) ||
        el.getAttribute('aria-modal') === 'true'
      );
      const ignored = (parentRec ? parentRec.flags.ignored : false) || (ignore ? safeMatches(el, ignore) : false);

      /** @type {any} */
      const rec = {
        i,
        parent: item.parent,
        depth: item.depth,
        tag: el.localName,
        selector: selectorOf(el),
        id: el.id || null,
        classes: typeof el.className === 'string' ? el.className.trim().replace(/\s+/g, ' ').slice(0, 160) : '',
        role: el.getAttribute('role'),
        name: interactive || popup ? accessibleName(el) : '',
        textSnippet: tg ? tg.snippet : '',
        attrs: attrsOf(el),
        rect: toRect(r),
        fragments: inline && clientRects.length > 1 ? Array.from(clientRects).slice(0, 12).map(toRect) : null,
        clipBox: {
          x: r2(r.left + el.clientLeft), y: r2(r.top + el.clientTop),
          w: r2(el.clientWidth), h: r2(el.clientHeight),
        },
        style: {
          display: cs.display,
          visibility: cs.visibility,
          opacity: px(cs.opacity),
          position: cs.position,
          zIndex: cs.zIndex,
          overflowX: ox,
          overflowY: oy,
          textOverflow: cs.textOverflow,
          whiteSpace: cs.whiteSpace,
          lineClamp: /** @type {any} */ (cs).webkitLineClamp || 'none',
          pointerEvents: cs.pointerEvents,
          transform: cs.transform !== 'none',
          float: cs.float,
          flexDirection: cs.flexDirection,
          flexWrap: cs.flexWrap,
          justifyContent: cs.justifyContent,
          alignItems: cs.alignItems,
          rowGap: cs.rowGap,
          columnGap: cs.columnGap,
          margin: [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)],
          padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
          border: [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)],
          fontSize: px(cs.fontSize),
          lineHeight: cs.lineHeight,
          width: cs.width,
          height: cs.height,
          maxHeight: cs.maxHeight,
          cursor: cs.cursor,
          contain: cs.contain,
        },
        scroll: {
          sw: el.scrollWidth, sh: el.scrollHeight, cw: el.clientWidth, ch: el.clientHeight,
          sl: r2(el.scrollLeft), st: r2(el.scrollTop),
        },
        flags: {
          rendered,
          visible,
          interactive,
          interactiveSource: semantic ? 'semantic' : cursorHint ? 'cursor' : null,
          focusable: /** @type {any} */ (el).tabIndex >= 0 && !disabled,
          disabled,
          ariaHidden,
          inert,
          srOnly,
          fixedCB: establishesFixedCB(cs),
          clips,
          scrollContainer: !inline && /(auto|scroll)/.test(ox + ' ' + oy),
          replaced: REPLACED.has(el.tagName),
          inShadow: item.inShadow,
          hasDirectText: !!(tg && tg.geom),
          popup,
          modal,
          inline,
          topLayer: inTopLayer(el),
          ignored,
        },
        text: tg ? tg.geom : null,
        trigger: -1,
        labelControl: -1,
        probes: [],
        textProbes: [],
        _inInteractive: inInteractive || semantic,
      };
      recs.push(rec);
      if (el.tagName === 'IFRAME') iframes++;

      // Children (pushed in reverse so they pop in document order).
      if (el.localName === 'svg' || el.tagName === 'IFRAME') continue;
      const kids = [];
      if (el.shadowRoot) {
        shadowRoots++;
        for (const c of el.shadowRoot.children) kids.push({ el: c, inShadow: true });
      }
      for (const c of el.children) {
        const slot = /** @type {any} */ (c).assignedSlot;
        kids.push({ el: c, inShadow: item.inShadow, slot });
      }
      for (let k = kids.length - 1; k >= 0; k--) {
        const kid = /** @type {any} */ (kids[k]);
        stack.push({ el: kid.el, parent: i, depth: item.depth + 1, inShadow: kid.inShadow });
      }
    }

    // Second pass: re-parent slotted light-DOM children onto their slot (flat tree),
    // and resolve cross-references.
    for (const rec of recs) {
      const el = els[rec.i];
      const slot = /** @type {any} */ (el).assignedSlot;
      if (slot && indexOf.has(slot)) {
        rec.parent = /** @type {number} */ (indexOf.get(slot));
        rec.depth = recs[rec.parent].depth + 1;
      }
      if (rec.flags.popup) {
        const t = triggerFor.get(el);
        if (t && indexOf.has(t)) rec.trigger = indexOf.get(t);
      }
      if (el.tagName === 'LABEL') {
        const c = /** @type {any} */ (el).control;
        if (c && indexOf.has(c)) rec.labelControl = indexOf.get(c);
      }
    }
    // Depths may have changed after slot re-parenting; recompute top-down.
    for (const rec of recs) if (rec.parent >= 0) rec.depth = recs[rec.parent].depth + 1;

    // Hit testing at scroll (0,0).
    let hitProbed = 0;
    /** @type {number[]} */
    const needScroll = [];
    for (const rec of recs) {
      if (hitProbed >= opts.maxHitElements) break;
      const f = rec.flags;
      if (!f.interactive || !f.visible || f.srOnly || f.ariaHidden || f.inert || f.ignored) continue;
      if (rec.style.pointerEvents === 'none') continue;
      const p = probe(els[rec.i], 'initial');
      rec.probes.push(p);
      hitProbed++;
      const tested = p.samples.filter((s) => !s.outside);
      if (!tested.length || tested.some((s) => !s.ok)) needScroll.push(rec.i);
    }

    // Scrolled probes: what a user gets after scrolling the control to the middle of
    // the viewport. scrollIntoView also scrolls overflow:hidden boxes programmatically,
    // so every clipping element's scroll offset is restored afterwards.
    const scrollers = recs.filter((r) => r.flags.clips).map((r) => [els[r.i], els[r.i].scrollLeft, els[r.i].scrollTop]);
    let scrolledProbes = 0;
    for (const idx of needScroll.slice(0, opts.maxScrolledProbes)) {
      const el = els[idx];
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: /** @type {any} */ ('instant') });
      recs[idx].probes.push(probe(el, 'scrolled'));
      scrolledProbes++;
    }
    for (const [el, l, t] of /** @type {any[]} */ (scrollers)) {
      el.scrollLeft = l;
      el.scrollTop = t;
    }

    // Text occlusion probes: points along each visible text line, probed with the window
    // scrolled in viewport-height steps so text below the fold is covered. A point is only
    // probed at the step where (in scroll-0 document coordinates) it falls inside the viewport.
    const textRecs = recs
      .filter((r) => r.text && r.flags.visible && !r.flags.interactive && !r.flags.srOnly && !r.flags.ignored && !r._inInteractive)
      .slice(0, opts.maxTextProbeElements);
    const vw0 = de.clientWidth;
    const vh0 = de.clientHeight;
    const steps = Math.max(1, Math.min(opts.maxTextScrollSteps, Math.ceil(de.scrollHeight / Math.max(1, vh0))));
    for (let s = 0; s < steps; s++) {
      window.scrollTo(0, s * vh0);
      const sy = window.scrollY;
      if (s > 0 && sy === 0) break;
      for (const rec of textRecs) {
        const el = els[rec.i];
        for (const line of rec.text.rects.slice(0, 4)) {
          for (const fx of [0.2, 0.5, 0.8]) {
            const x = line.x + line.w * fx;
            const y = line.y + line.h / 2;
            if (x < 0 || x >= vw0 || y < sy || y >= sy + vh0) continue;
            if (rec.textProbes.length >= 12) break;
            const hit = deepElementFromPoint(x, y - sy);
            const ok = !!hit && (composedContains(el, hit) || composedContains(hit, el));
            rec.textProbes.push({
              x: r2(x), y: r2(y), sy,
              top: hit ? indexForNode(hit) : -1,
              topSelector: hit && !ok ? selectorOf(hit) : null,
              ok,
            });
          }
        }
      }
    }
    window.scrollTo(0, 0);

    /** @type {{selector:string, tag:string, name:string}[]} */
    const unrenderedControls = [];
    for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      const idx = indexOf.get(el);
      if (idx !== undefined && recs[idx].flags.visible) continue;
      if (unrenderedControls.length >= 400) break;
      unrenderedControls.push({ selector: selectorOf(el), tag: el.localName, name: accessibleName(el) });
    }
    const disclosureControls = recs
      .filter((r) => r.flags.visible && !r.flags.ariaHidden && (
        r.attrs.ariaExpanded !== undefined || r.tag === 'summary' ||
        (r.attrs.ariaHaspopup !== undefined && r.attrs.ariaHaspopup !== 'false') ||
        els[r.i].hasAttribute('popovertarget')))
      .map((r) => r.selector);

    for (const rec of recs) delete rec._inInteractive;
    const rootCs = getComputedStyle(de);
    const bodyCs = body ? getComputedStyle(body) : rootCs;
    return {
      url: location.href,
      title: document.title,
      collectedAt: new Date().toISOString(),
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        clientWidth: de.clientWidth,
        clientHeight: de.clientHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      doc: {
        scrollWidth: de.scrollWidth,
        scrollHeight: de.scrollHeight,
        rootOverflowX: rootCs.overflowX,
        rootOverflowY: rootCs.overflowY,
        bodyOverflowX: bodyCs.overflowX,
        bodyOverflowY: bodyCs.overflowY,
        dir: rootCs.direction,
      },
      elements: recs,
      unrenderedControls,
      disclosureControls,
      stats: {
        domElements: document.getElementsByTagName('*').length,
        recorded: recs.length,
        truncated,
        openShadowRoots: shadowRoots,
        iframes,
        hitProbedElements: hitProbed,
        scrolledProbes,
        textProbedElements: textRecs.length,
        collectMs: Math.round(performance.now() - t0),
      },
    };
  }

  function safeMatches(/** @type {Element} */ el, /** @type {string} */ sel) {
    try {
      return el.matches(sel);
    } catch {
      return false;
    }
  }

  function attrsOf(/** @type {Element} */ el) {
    /** @type {Record<string, string>} */
    const a = {};
    const map = /** @type {[string, string][]} */ ([
      ['type', 'type'], ['href', 'href'], ['aria-expanded', 'ariaExpanded'], ['aria-controls', 'ariaControls'],
      ['aria-haspopup', 'ariaHaspopup'], ['aria-roledescription', 'ariaRoledescription'], ['title', 'title'], ['for', 'forId'],
    ]);
    for (const [attr, key] of map) {
      const v = el.getAttribute(attr);
      if (v !== null) a[key] = v.slice(0, 160);
    }
    return a;
  }

  // ---------------------------------------------------------------- verifier probes
  function rectOfIndex(/** @type {number} */ i) {
    const el = els[i];
    if (!el || !el.isConnected) return null;
    return toRect(el.getBoundingClientRect());
  }

  function remeasure(/** @type {number[]} */ indices) {
    return { rects: indices.map(rectOfIndex), scrollX: window.scrollX, scrollY: window.scrollY };
  }

  function reveal(/** @type {number[]} */ indices) {
    const rects = indices.map(rectOfIndex).filter(Boolean);
    if (rects.length) {
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const x1 = Math.min(...rects.map((r) => /** @type {any} */ (r).x));
      const y1 = Math.min(...rects.map((r) => /** @type {any} */ (r).y));
      const x2 = Math.max(...rects.map((r) => /** @type {any} */ (r).x + /** @type {any} */ (r).w));
      const y2 = Math.max(...rects.map((r) => /** @type {any} */ (r).y + /** @type {any} */ (r).h));
      let dx = 0;
      let dy = 0;
      if (y1 < 0 || y2 > vh) dy = y2 - y1 <= vh ? y1 - (vh - (y2 - y1)) / 2 : y1 - 16;
      if (x1 < 0 || x2 > vw) dx = x2 - x1 <= vw ? x1 - (vw - (x2 - x1)) / 2 : x1 - 16;
      if (dx || dy) window.scrollBy(dx, dy);
    }
    return remeasure(indices);
  }

  function stackAt(/** @type {number} */ x, /** @type {number} */ y) {
    /** @type {number[]} */
    const out = [];
    for (const el of document.elementsFromPoint(x, y)) {
      const i = indexForNode(el);
      if (i >= 0 && !out.includes(i)) out.push(i);
    }
    return out;
  }

  function override(/** @type {number} */ i, /** @type {string} */ prop, /** @type {string} */ value) {
    const el = /** @type {HTMLElement} */ (els[i]);
    if (!el || !el.style) return false;
    const key = i + '|' + prop;
    if (!overrides.has(key)) {
      overrides.set(key, {
        el, prop, value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop),
        hadStyle: el.hasAttribute('style'),
      });
    }
    el.style.setProperty(prop, value, 'important');
    return true;
  }

  function restore() {
    for (const o of overrides.values()) {
      if (o.value) o.el.style.setProperty(o.prop, o.value, o.priority);
      else o.el.style.removeProperty(o.prop);
      if (!o.hadStyle && o.el.getAttribute('style') === '') o.el.removeAttribute('style');
    }
    overrides.clear();
    return true;
  }

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function focusProbe(/** @type {number} */ i) {
    const el = /** @type {HTMLElement} */ (els[i]);
    if (!el || !el.isConnected) return null;
    const sx = window.scrollX;
    const sy = window.scrollY;
    const prev = /** @type {HTMLElement|null} */ (deepActive());
    /** @type {[Element, number, number][]} */
    const scrollers = [];
    for (let p = flatParent(el); p; p = flatParent(p)) {
      const pe = /** @type {Element} */ (p);
      scrollers.push([pe, pe.scrollLeft, pe.scrollTop]);
    }
    const before = toRect(el.getBoundingClientRect());
    el.focus();
    const focused = deepActive() === el;
    const after = toRect(el.getBoundingClientRect());
    const windowScrolled = window.scrollX !== sx || window.scrollY !== sy;
    const ancestorScrolled = scrollers.some(([p, l, t]) => p.scrollLeft !== l || p.scrollTop !== t);
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const ix = Math.max(0, Math.min(after.x + after.w, vw) - Math.max(after.x, 0));
    const iy = Math.max(0, Math.min(after.y + after.h, vh) - Math.max(after.y, 0));
    const area = after.w * after.h;
    const inViewportFraction = area > 0 ? r2((ix * iy) / area) : 0;
    if (prev && prev !== document.body && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
    else el.blur();
    for (const [p, l, t] of scrollers) {
      p.scrollLeft = l;
      p.scrollTop = t;
    }
    window.scrollTo(sx, sy);
    return { focused, before, after, windowScrolled, ancestorScrolled, inViewportFraction };
  }

  function maxScrollX() {
    const sx = window.scrollX;
    const sy = window.scrollY;
    window.scrollTo(1e7, sy);
    const reached = window.scrollX;
    window.scrollTo(sx, sy);
    return reached;
  }

  /**
   * Scroll the window and every scrollable ancestor of element i as far as they go (right and
   * down), measure how much of the element is still outside the viewport, then restore.
   */
  function reachProbe(/** @type {number} */ i) {
    const el = els[i];
    if (!el || !el.isConnected) return null;
    const sx = window.scrollX;
    const sy = window.scrollY;
    /** @type {[Element, number, number][]} */
    const saved = [];
    for (let p = flatParent(el); p; p = flatParent(p)) {
      const pe = /** @type {Element} */ (p);
      saved.push([pe, pe.scrollLeft, pe.scrollTop]);
      pe.scrollTop = 1e7;
    }
    window.scrollTo(sx, 1e7);
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const result = {
      rect: toRect(r),
      beyondBottom: r2(Math.max(0, r.bottom - vh)),
      beyondRight: r2(Math.max(0, r.right - vw)),
      windowScrollY: window.scrollY,
    };
    for (const [p, l, t] of saved) {
      p.scrollLeft = l;
      p.scrollTop = t;
    }
    window.scrollTo(sx, sy);
    return result;
  }

  /** Index of the first element matching a CSS selector (light DOM), or -1. */
  function indexOfSelector(/** @type {string} */ sel) {
    let el = null;
    try {
      el = document.querySelector(sel);
    } catch {
      return -1;
    }
    const i = el ? indexOf.get(el) : undefined;
    return i === undefined ? -1 : i;
  }

  w.__uqa = { version: VERSION, collect, remeasure, reveal, stackAt, override, restore, focusProbe, maxScrollX, reachProbe, indexOfSelector };
  return true;
})();
