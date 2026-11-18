// @ts-check
/**
 * Universal QA MCP — in-page observer for the browser operator.
 *
 * Installed with context.addInitScript (and evaluated once on already-loaded pages). Plain JS
 * for the same reason as collector.js: injected verbatim, so it must be self-contained.
 *
 * window.__uqaObs:
 *   mutations   - running count of DOM mutation records (used to detect a settled UI)
 *   observe(o)  - semantic snapshot: actionable controls, forms, open overlays, live-region
 *                 messages, headings, focus, and challenge signals (CAPTCHA / auth / MFA / blocked)
 *
 * Read-only: it never clicks, types or changes the page.
 */
(() => {
  const VERSION = 1;
  const w = /** @type {any} */ (window);
  if (w.__uqaObs && w.__uqaObs.version === VERSION) return true;

  const state = { version: VERSION, mutations: 0, observe, hitInfo };
  const startObserver = () => {
    try {
      new MutationObserver((list) => {
        state.mutations += list.length;
      }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {}
  };
  if (document.documentElement) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

  const CONTROL_SELECTOR =
    'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="tab"],' +
    '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="checkbox"],[role="radio"],' +
    '[role="switch"],[role="combobox"],[role="textbox"],[role="slider"],[role="treeitem"],[contenteditable="true"],' +
    '[tabindex]:not([tabindex="-1"]),[draggable="true"]';
  const OVERLAY_SELECTOR =
    'dialog[open],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tooltip"],[popover]';
  const CAPTCHA_SRC = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|captcha/i;
  const CAPTCHA_MARK = /g-recaptcha|h-captcha|cf-turnstile|captcha/i;
  const CAPTCHA_TEXT = /verify (that )?you are (a )?human|i'?m not a robot|complete the (security )?(check|captcha)|are you a robot|human verification/i;
  const MFA_TEXT = /verification code|one-time (pass)?code|two-factor|2-step verification|authenticator app|security key/i;
  const BLOCK_TEXT = /access denied|forbidden|too many requests|rate limit(ed)?|unusual traffic|you have been blocked|request blocked/i;
  const IDENT = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/;

  /** All elements matching `sel` in the document and open shadow roots. */
  function deepQueryAll(/** @type {string} */ sel) {
    /** @type {Element[]} */
    const out = [];
    /** @type {(Document|ShadowRoot)[]} */
    const roots = [document];
    while (roots.length) {
      const root = /** @type {Document|ShadowRoot} */ (roots.pop());
      for (const el of root.querySelectorAll(sel)) out.push(el);
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    }
    return out;
  }

  function hash(/** @type {string} */ s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function isVisible(/** @type {Element} */ el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const e = /** @type {any} */ (el);
    if (typeof e.checkVisibility === 'function') {
      return e.checkVisibility({ checkOpacity: true, opacityProperty: true, checkVisibilityCSS: true, visibilityProperty: true });
    }
    const cs = getComputedStyle(el);
    return cs.visibility === 'visible' && cs.display !== 'none' && Number(cs.opacity) > 0;
  }

  /** @type {Map<Element,string>} */
  let selCache = new Map();
  /** @returns {string} */
  function selectorOf(/** @type {Element} */ el) {
    const cached = selCache.get(el);
    if (cached) return cached;
    const root = /** @type {any} */ (el.getRootNode());
    let sel;
    const testId = el.getAttribute('data-testid');
    if (el.id && root.querySelectorAll('#' + CSS.escape(el.id)).length === 1) sel = '#' + CSS.escape(el.id);
    else if (testId && root.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`).length === 1) sel = `[data-testid="${CSS.escape(testId)}"]`;
    else if (el === document.body) sel = 'body';
    else if (el === document.documentElement) sel = 'html';
    else {
      let part = el.localName;
      const cls = Array.from(el.classList).filter((c) => IDENT.test(c) && c.length < 32).slice(0, 2);
      for (const c of cls) part += '.' + CSS.escape(c);
      const parent = el.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((s) => s.localName === el.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
        sel = `${selectorOf(parent)} > ${part}`;
      } else sel = part;
    }
    if (root !== document && root.host && !el.parentElement) sel = `${selectorOf(root.host)} >> ${sel}`;
    selCache.set(el, sel);
    return sel;
  }

  function byId(/** @type {Element} */ from, /** @type {string} */ id) {
    const root = /** @type {any} */ (from.getRootNode());
    return (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
  }

  function nameOf(/** @type {Element} */ el) {
    const e = /** @type {any} */ (el);
    const clean = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim().slice(0, 80);
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => byId(el, id)?.textContent || '').join(' ');
      if (t.trim()) return clean(t);
    }
    if (e.labels && e.labels.length) {
      const t = e.labels[0].textContent || '';
      if (t.trim()) return clean(t);
    }
    if (el.tagName === 'INPUT' && /^(submit|button|reset)$/.test(e.type) && e.value) return clean(String(e.value));
    const text = /** @type {HTMLElement} */ (el).innerText || el.textContent || '';
    if (text.trim()) return clean(text);
    for (const a of ['title', 'placeholder', 'alt', 'name']) {
      const v = el.getAttribute(a);
      if (v && v.trim()) return clean(v);
    }
    return '';
  }

  function roleOf(/** @type {Element} */ el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0] || explicit;
    const tag = el.tagName;
    const e = /** @type {any} */ (el);
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return e.multiple || e.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const t = e.type;
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (/^(submit|button|reset|image)$/.test(t)) return 'button';
      if (t === 'search') return 'searchbox';
      if (t === 'number') return 'spinbutton';
      if (t === 'file') return 'button';
      return 'textbox';
    }
    if (/** @type {HTMLElement} */ (el).isContentEditable) return 'textbox';
    return 'generic';
  }

  function boolAttr(/** @type {Element} */ el, /** @type {string} */ a) {
    const v = el.getAttribute(a);
    return v === null ? undefined : v === 'true';
  }

  function isSubmit(/** @type {Element} */ el) {
    const e = /** @type {any} */ (el);
    if (el.tagName === 'BUTTON') return !!e.form && (e.type || 'submit') === 'submit';
    if (el.tagName === 'INPUT') return !!e.form && (e.type === 'submit' || e.type === 'image');
    return false;
  }

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  /** What receives a pointer event at the centre of `el` (used to name the interceptor of a blocked click). */
  function hitInfo(/** @type {Element} */ el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return { ok: !!hit && (hit === el || el.contains(hit)), hit: hit ? selectorOf(hit) : null, x: Math.round(x), y: Math.round(y) };
  }

  /** @param {{ maxControls?: number }} [opts] */
  function observe(opts) {
    const maxControls = (opts && opts.maxControls) || 400;
    selCache = new Map();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    const overlayEls = deepQueryAll(OVERLAY_SELECTOR).filter((el) => {
      if (!isVisible(el)) return false;
      if (el.hasAttribute('popover')) {
        try {
          return el.matches(':popover-open');
        } catch {
          return false;
        }
      }
      return true;
    });
    const overlays = overlayEls.map((el, index) => ({ index, selector: selectorOf(el), role: roleOf(el) === 'generic' ? el.localName : roleOf(el), name: nameOf(el).slice(0, 60) }));

    const formEls = Array.from(document.forms);
    /** @type {any[]} */
    const controls = [];
    let truncated = false;
    for (const el of deepQueryAll(CONTROL_SELECTOR)) {
      if (controls.length >= maxControls) {
        truncated = true;
        break;
      }
      if (!isVisible(el)) continue;
      const e = /** @type {any} */ (el);
      const r = el.getBoundingClientRect();
      const role = roleOf(el);
      const name = nameOf(el);
      const type = el.tagName === 'INPUT' ? String(e.type) : el.tagName === 'BUTTON' ? String(e.type || 'submit') : null;
      const ariaChecked = el.getAttribute('aria-checked');
      /** @type {any} */
      const st = {};
      const expanded = boolAttr(el, 'aria-expanded');
      if (expanded !== undefined) st.expanded = expanded;
      if (el.tagName === 'INPUT' && (e.type === 'checkbox' || e.type === 'radio')) st.checked = !!e.checked;
      else if (ariaChecked !== null) st.checked = ariaChecked === 'true';
      const selected = boolAttr(el, 'aria-selected');
      if (selected !== undefined) st.selected = selected;
      const pressed = boolAttr(el, 'aria-pressed');
      if (pressed !== undefined) st.pressed = pressed;
      if ('value' in e && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) {
        st.value = e.type === 'password' ? (e.value ? '***' : '') : e.type === 'file' ? Array.from(e.files || []).map((/** @type {any} */ f) => f.name).join(',') : String(e.value).slice(0, 120);
      }
      if (e.required) st.required = true;
      const invalid = el.getAttribute('aria-invalid') === 'true' || (typeof e.checkValidity === 'function' && e.willValidate && !e.validity.valid);
      if (invalid) st.invalid = true;
      if (el.getAttribute('draggable') === 'true') st.draggable = true;
      const hp = el.getAttribute('aria-haspopup');
      if (hp && hp !== 'false') st.haspopup = hp;
      const overlayIdx = overlayEls.findIndex((o) => o !== el && o.contains(el));
      const formIdx = e.form ? formEls.indexOf(e.form) : -1;
      const sigName = name.toLowerCase().replace(/\d+/g, '#').slice(0, 40);
      controls.push({
        ref: 'c' + controls.length,
        selector: selectorOf(el),
        role,
        name,
        tag: el.localName,
        type,
        href: el.tagName === 'A' ? e.href || null : null,
        target: el.getAttribute('target'),
        bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        inViewport: r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw,
        enabled: !e.disabled && el.getAttribute('aria-disabled') !== 'true',
        state: st,
        form: formIdx,
        overlay: overlayIdx,
        submit: isSubmit(el),
        signature: `${role}|${sigName}`,
      });
    }
    const refOf = new Map(controls.map((c) => [c.selector, c.ref]));
    const forms = formEls
      .filter((f) => isVisible(f))
      .map((f, index) => {
        const fields = Array.from(f.elements).map((x) => refOf.get(selectorOf(/** @type {Element} */ (x)))).filter(Boolean);
        const submits = controls.filter((c) => c.submit && c.form === formEls.indexOf(f)).map((c) => c.ref);
        return { index: formEls.indexOf(f), selector: selectorOf(f), method: (f.getAttribute('method') || 'get').toLowerCase(), action: f.action || '', fields, submits };
      });

    const alerts = deepQueryAll('[role="alert"],[role="status"],[aria-live="assertive"],[aria-live="polite"]')
      .filter((el) => isVisible(el) && (el.textContent || '').trim())
      .map((el) => ({ role: el.getAttribute('role') || 'live', text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) }));
    const headings = deepQueryAll('h1,h2,h3')
      .filter(isVisible)
      .slice(0, 10)
      .map((h) => (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80));
    const passwordFieldVisible = deepQueryAll('input[type="password"]').some(isVisible);

    // Challenge signals. Detection only: the operator stops and asks a human; it never interacts with them.
    const bodyText = (document.body ? document.body.innerText : '').slice(0, 20000);
    /** @type {any} */
    let challenge = null;
    const captchaFrame = Array.from(document.querySelectorAll('iframe')).find((f) => CAPTCHA_SRC.test(f.src || '') || CAPTCHA_MARK.test(f.title || ''));
    const captchaMark = document.querySelector('[data-sitekey],.g-recaptcha,.h-captcha,.cf-turnstile,[id*="captcha" i],[class*="captcha" i]');
    if (captchaFrame || captchaMark || CAPTCHA_TEXT.test(bodyText)) {
      challenge = {
        kind: 'captcha',
        reason: 'A CAPTCHA / human-verification challenge is present.',
        evidence: captchaFrame ? `iframe ${captchaFrame.src || captchaFrame.title}` : captchaMark ? selectorOf(captchaMark) : (bodyText.match(CAPTCHA_TEXT) || [''])[0],
      };
    } else if (MFA_TEXT.test(bodyText) && deepQueryAll('input').some((i) => isVisible(i) && /code|otp|token/i.test(i.getAttribute('name') || i.getAttribute('autocomplete') || i.id || ''))) {
      challenge = { kind: 'mfa', reason: 'A multi-factor authentication prompt is present.', evidence: (bodyText.match(MFA_TEXT) || [''])[0] };
    } else if (BLOCK_TEXT.test(document.title) || (BLOCK_TEXT.test(bodyText.slice(0, 400)) && bodyText.length < 3000)) {
      challenge = { kind: 'blocked', reason: 'The page reports that access is blocked or rate limited.', evidence: (document.title.match(BLOCK_TEXT) || bodyText.match(BLOCK_TEXT) || [''])[0] };
    }

    const focused = deepActive();
    return {
      url: location.href,
      title: document.title,
      controls,
      forms,
      overlays,
      alerts,
      headings,
      focused: focused && focused !== document.body ? selectorOf(focused) : null,
      passwordFieldVisible,
      textHash: hash(bodyText.replace(/\d+/g, '#')),
      challenge,
      truncated,
    };
  }

  w.__uqaObs = state;
  return true;
})();
