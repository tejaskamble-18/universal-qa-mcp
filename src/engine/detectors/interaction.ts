import { type Candidate, type Detector, cssq } from '../candidate.js';
import {
  area,
  clipRect,
  clipRegionFrom,
  gapBetween,
  hiddenOutside,
  intersectRegions,
  round2,
  roundRect,
  UNBOUNDED,
  type ClipRegion,
} from '../geometry.js';
import type { SnapshotModel } from '../model.js';
import type { HitProbe, HitSample, Rect } from '../snapshot-types.js';
import type { SeverityT } from '../../report/schema.js';

const RANK: Record<SeverityT, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

function inRegion(region: ClipRegion, x: number, y: number): boolean {
  return x >= region.x1 && x <= region.x2 && y >= region.y1 && y <= region.y2;
}

interface Blocked {
  target: number;
  probe: HitProbe;
  valid: HitSample[];
  blocked: HitSample[];
  fraction: number;
  severity: SeverityT;
}

export const obstructedTargetDetector: Detector = {
  category: 'obstructed-target',
  description:
    'Controls whose visible area is covered for pointer input: document.elementFromPoint at sample points inside the control returns a different, ' +
    'unrelated element (also after scrolling the control to the centre). Open modals/popups covering the page are recognised as intentional.',
  run({ model }) {
    const groups = new Map<string, { obstructor: number; topSelector: string; items: Blocked[] }>();
    const out: Candidate[] = [];
    const openModal = model.els.find((e) => e.flags.modal && e.flags.visible);
    const vpArea = area(model.viewport);
    for (const e of model.els) {
      if (!e.probes.length) continue;
      const probe = e.probes.find((p) => p.mode === 'scrolled') ?? e.probes[0]!;
      const region = model.paintRegion(e.i);
      const valid = probe.samples.filter((s) => {
        if (s.outside) return false;
        // Sample position in snapshot coordinates (relative to the element's own box).
        const x = e.rect.x + e.rect.w * s.fx;
        const y = e.rect.y + e.rect.h * s.fy;
        return inRegion(region, x, y);
      });
      const blocked = valid.filter((s) => !s.ok);
      if (!valid.length || !blocked.length) continue;
      const counts = new Map<string, { idx: number; sel: string; n: number }>();
      for (const s of blocked) {
        const k = s.top >= 0 ? `i${s.top}` : `s${s.topSelector ?? 'unknown'}`;
        const c = counts.get(k) ?? { idx: s.top, sel: s.topSelector ?? 'unknown', n: 0 };
        c.n++;
        counts.set(k, c);
      }
      const main = [...counts.values()].sort((a, b) => b.n - a.n)[0]!;
      const fraction = blocked.length / valid.length;
      let severity: SeverityT = fraction >= 0.99 ? 'high' : 'medium';
      if (e.flags.disabled) severity = 'low';
      else if (e.flags.interactiveSource === 'cursor') severity = severity === 'high' ? 'medium' : 'low';
      const item: Blocked = { target: e.i, probe, valid, blocked, fraction, severity };

      if (main.idx >= 0) {
        const lo = model.layer(main.idx);
        const lt = model.layer(e.i);
        if ((lo.kind === 'modal' || lo.kind === 'top-layer') && lo.root !== lt.root) {
          out.push(suppressedOne(model, item, main.idx, {
            rule: 'covered-by-open-modal',
            reason: `${model.label(e.i)} is behind the open modal ${model.label(lo.root)}; blocking the page is expected while it is open.`,
          }));
          continue;
        }
        // A custom modal's backdrop is typically a full-viewport fixed sibling of the dialog.
        const ob = model.el(main.idx);
        const vis = model.visibleRect(main.idx);
        if (
          openModal && lt.root !== openModal.i && !model.isAncestor(openModal.i, e.i) &&
          lo.kind === 'fixed' && vis && area(vis) >= 0.9 * vpArea && !ob.flags.hasDirectText
        ) {
          out.push(suppressedOne(model, item, main.idx, {
            rule: 'covered-by-open-modal',
            reason: `${model.label(e.i)} is under ${model.label(main.idx)}, a full-viewport backdrop shown with the open modal ${model.label(openModal.i)}.`,
          }));
          continue;
        }
        if (lo.kind === 'popup' && lo.root !== lt.root) {
          out.push(suppressedOne(model, item, main.idx, {
            rule: 'covered-by-open-popup',
            reason: `${model.label(e.i)} is under the open popup ${model.label(lo.root)}.`,
          }));
          continue;
        }
      }
      const gkey = main.idx >= 0 ? model.el(main.idx).selector : main.sel;
      const g = groups.get(gkey) ?? { obstructor: main.idx, topSelector: main.sel, items: [] };
      g.items.push(item);
      groups.set(gkey, g);
    }

    for (const [obSel, g] of groups) out.push(obstructionCandidate(model, obSel, g));
    return out;
  },
};

type Group = { obstructor: number; topSelector: string; items: Blocked[] };

function obstructionCandidate(model: SnapshotModel, obSel: string, g: Group): Candidate {
  const worst = g.items.reduce((a, b) => (b.fraction > a.fraction ? b : a));
  const severity = g.items.reduce<SeverityT>((s, it) => (RANK[it.severity] > RANK[s] ? it.severity : s), 'info');
  const firstBlocked = worst.blocked[0]!;
  const te = model.el(worst.target);
  const obLabel = g.obstructor >= 0 ? model.label(g.obstructor) : obSel;
  return {
    rebuild: (keep) => {
      const items = g.items.filter((it) => keep.includes(it.target));
      return items.length ? obstructionCandidate(model, obSel, { ...g, items }) : null;
    },
    category: 'obstructed-target',
    key: `obstructed-target|${obSel}`,
    title: g.items.length > 1 ? `${obLabel} intercepts clicks on ${g.items.length} controls` : 'Click target is covered by another element',
    description:
      g.items
        .slice(0, 5)
        .map((it) => `${model.label(it.target)}: ${it.blocked.length}/${it.valid.length} probe points hit ${obLabel}`)
        .join('; ') + (g.items.length > 5 ? '; …' : '') +
      `. Probed ${worst.probe.mode === 'scrolled' ? 'after scrolling the control to the viewport centre' : 'at the initial scroll position'}.`,
    severity,
    confidence: 0.8,
    maxStatus: 'verified',
    elements: [
      ...(g.obstructor >= 0 ? [{ index: g.obstructor, role: 'obstructor' as const }] : []),
      ...g.items.map((it) => ({ index: it.target, role: 'subject' as const })),
    ],
    measurements: {
      obstructorSelector: obSel,
      obstructorStyle: g.obstructor >= 0 ? obstructorFacts(model, g.obstructor) : null,
      targets: g.items.map((it) => ({
        selector: model.el(it.target).selector,
        name: model.el(it.target).name,
        blockedSamples: it.blocked.length,
        validSamples: it.valid.length,
        blockedFraction: round2(it.fraction),
        probeMode: it.probe.mode,
        scroll: { x: it.probe.scrollX, y: it.probe.scrollY },
      })),
      hitTests: g.items.flatMap((it) =>
        it.valid.map((s) => ({
          mode: it.probe.mode,
          x: s.x,
          y: s.y,
          expected: model.el(it.target).selector,
          topSelector: s.ok ? model.el(it.target).selector : s.top >= 0 ? model.el(s.top).selector : s.topSelector,
          ok: s.ok,
        })),
      ),
    },
    verify:
      g.obstructor >= 0
        ? [{
            kind: 'cover',
            obstructor: g.obstructor,
            target: worst.target,
            fx: firstBlocked.fx,
            fy: firstBlocked.fy,
            scroll: { x: worst.probe.scrollX, y: worst.probe.scrollY },
          }]
        : [],
    consoleCheck:
      `(() => { const t = document.querySelector(${cssq(te.selector)}); t.scrollIntoView({block: 'center'}); ` +
      `const r = t.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width * ${firstBlocked.fx}, r.top + r.height * ${firstBlocked.fy}); ` +
      `return { hit, isTargetOrInside: t.contains(hit) }; })()`,
    notes: [],
  };
}

function obstructorFacts(model: SnapshotModel, i: number): Record<string, unknown> {
  const e = model.el(i);
  return {
    position: e.style.position,
    zIndex: e.style.zIndex,
    pointerEvents: e.style.pointerEvents,
    opacity: e.style.opacity,
    rect: roundRect(e.rect),
  };
}

function suppressedOne(model: SnapshotModel, it: Blocked, obstructor: number, suppressed: NonNullable<Candidate['suppressed']>): Candidate {
  return {
    category: 'obstructed-target',
    key: `obstructed-target|${model.el(obstructor).selector}|${model.el(it.target).selector}`,
    title: 'Covered control (suppressed)',
    description: `${model.label(it.target)} is covered by ${model.label(obstructor)}.`,
    severity: 'info',
    confidence: 0.5,
    maxStatus: 'potential',
    elements: [
      { index: obstructor, role: 'obstructor' },
      { index: it.target, role: 'subject' },
    ],
    measurements: { blockedFraction: round2(it.fraction) },
    verify: [],
    consoleCheck: '',
    notes: [],
    suppressed,
  };
}

function nearestClipperCutting(model: SnapshotModel, i: number, r: Rect): number {
  for (const c of model.clipInfo(i).chain) {
    const vis = clipRect(r, model.clipperRegion(c, { hidden: true, scroll: true }));
    if (!vis || vis.w < r.w - 0.5 || vis.h < r.h - 0.5) return c;
  }
  return -1;
}

export const popupClippingDetector: Detector = {
  category: 'popup-clipping',
  description:
    'Open dropdowns, menus, listboxes, tooltips, popovers and dialogs that are cut off by an overflow container, or extend past the viewport ' +
    'with no way to scroll to the hidden part.',
  run({ model, t }) {
    const out: Candidate[] = [];
    for (const p of model.els) {
      if (!p.flags.popup || !p.flags.visible || p.flags.ignored) continue;
      const info = model.clipInfo(p.i);
      // (a) clipped by an ancestor (hidden or scrolling) box
      let anc = UNBOUNDED;
      for (const c of info.chain) anc = intersectRegions(anc, model.clipperRegion(c, { hidden: true, scroll: true }));
      const ha = hiddenOutside([p.rect], anc);
      if (Math.max(ha.maxHiddenX, ha.maxHiddenY) >= t.clipMinPx && ha.hiddenFraction >= 0.05) {
        const clipper = nearestClipperCutting(model, p.i, p.rect);
        const ce = clipper >= 0 ? model.el(clipper) : null;
        out.push({
          category: 'popup-clipping',
          key: `popup-clipping|${p.selector}|container`,
          title: 'Popup is clipped by its container',
          description:
            `${model.label(p.i)} is ${Math.round(ha.hiddenFraction * 100)}% hidden by ` +
            `${ce ? `${model.label(clipper)} (overflow ${ce.style.overflowX}/${ce.style.overflowY})` : 'an ancestor'}; ` +
            'part of its options cannot be seen or clicked.',
          severity: 'high',
          confidence: 0.8,
          maxStatus: 'verified',
          elements: [
            { index: p.i, role: 'subject' },
            ...(clipper >= 0 ? [{ index: clipper, role: 'container' as const }] : []),
            ...(p.trigger >= 0 ? [{ index: p.trigger, role: 'trigger' as const }] : []),
          ],
          measurements: {
            variant: 'clipped-by-container',
            popupRect: roundRect(p.rect),
            hiddenFraction: round2(ha.hiddenFraction),
            hiddenPxX: round2(ha.maxHiddenX),
            hiddenPxY: round2(ha.maxHiddenY),
            clipper: ce ? { selector: ce.selector, clipBox: roundRect(ce.clipBox), overflowX: ce.style.overflowX, overflowY: ce.style.overflowY } : null,
            popupPosition: p.style.position,
          },
          verify:
            clipper >= 0
              ? [{ kind: 'unclip', clipper, element: p.i, region: ha.hiddenRects.sort((a, b) => area(b) - area(a))[0] ?? p.rect }]
              : [],
          consoleCheck: `document.querySelector(${cssq(p.selector)}).getBoundingClientRect()`,
          notes: [],
        });
      }
      // (b) extends past the viewport
      const vpRegion = clipRegionFrom(model.viewport, { x: true, y: true });
      const hv = hiddenOutside([p.rect], vpRegion);
      if (info.fixedToViewport) {
        const scrollableAncestor = info.chain.some((c) => {
          const e = model.el(c);
          return e.flags.scrollContainer && (e.scroll.sh > e.scroll.ch + 1 || e.scroll.sw > e.scroll.cw + 1);
        });
        if (Math.max(hv.maxHiddenX, hv.maxHiddenY) >= t.clipMinPx && hv.hiddenFraction >= 0.02 && !scrollableAncestor) {
          out.push(exceeds(model, p.i, hv, 'high', 'It is fixed to the viewport and neither it nor a containing layer scrolls, so the hidden part is unreachable.'));
        }
      } else if (hv.maxHiddenX >= t.clipMinPx && hv.hiddenFraction >= 0.02 && !info.chain.length) {
        out.push(exceeds(model, p.i, hv, 'medium', 'It sticks out past the left/right edge of the viewport.'));
      }
    }
    return out;
  },
};

function exceeds(
  model: SnapshotModel,
  i: number,
  hv: { hiddenFraction: number; maxHiddenX: number; maxHiddenY: number },
  severity: SeverityT,
  why: string,
): Candidate {
  const p = model.el(i);
  return {
    category: 'popup-clipping',
    key: `popup-clipping|${p.selector}|viewport`,
    title: p.flags.modal ? 'Dialog does not fit in the viewport' : 'Popup extends past the viewport',
    description:
      `${model.label(i)} (${round2(p.rect.w)}×${round2(p.rect.h)}px at ${round2(p.rect.x)},${round2(p.rect.y)}) is ` +
      `${Math.round(hv.hiddenFraction * 100)}% outside the ${model.viewport.w}×${model.viewport.h}px viewport. ${why}`,
    severity,
    confidence: 0.8,
    maxStatus: 'verified',
    elements: [{ index: i, role: 'subject' }, ...(p.trigger >= 0 ? [{ index: p.trigger, role: 'trigger' as const }] : [])],
    measurements: {
      variant: 'exceeds-viewport',
      popupRect: roundRect(p.rect),
      viewport: { width: model.viewport.w, height: model.viewport.h },
      hiddenFraction: round2(hv.hiddenFraction),
      hiddenPxX: round2(hv.maxHiddenX),
      hiddenPxY: round2(hv.maxHiddenY),
      overflowY: p.style.overflowY,
      maxHeight: p.style.maxHeight,
      position: p.style.position,
    },
    verify: [{ kind: 'reach', element: i }],
    consoleCheck: `(() => { const r = document.querySelector(${cssq(p.selector)}).getBoundingClientRect(); return { bottom: r.bottom, right: r.right, innerHeight, innerWidth }; })()`,
    notes: [],
  };
}

export const popupPlacementDetector: Detector = {
  category: 'popup-placement',
  description:
    'Open non-modal popups (menus, listboxes, popovers) rendered far away from the control that opened them (aria-controls/aria-expanded, popovertarget, aria-labelledby).',
  run({ model, t }) {
    const out: Candidate[] = [];
    for (const p of model.els) {
      if (!p.flags.popup || !p.flags.visible || p.flags.modal || p.trigger < 0 || p.flags.ignored) continue;
      if (p.role === 'dialog' || p.role === 'alertdialog' || p.tag === 'dialog') continue;
      const tr = model.el(p.trigger);
      if (!tr.flags.visible) continue;
      const gap = gapBetween(p.rect, tr.rect);
      if (gap <= t.popupDetachPx) continue;
      out.push({
        category: 'popup-placement',
        key: `popup-placement|${p.selector}`,
        title: 'Popup is rendered away from its trigger',
        description:
          `${model.label(p.i)} opened by ${model.label(p.trigger)} is ${Math.round(gap)}px away from it ` +
          `(popup at ${round2(p.rect.x)},${round2(p.rect.y)}; trigger at ${round2(tr.rect.x)},${round2(tr.rect.y)}). ` +
          'This usually means the popup is positioned against the wrong containing block.',
        severity: 'medium',
        confidence: 0.75,
        maxStatus: 'verified',
        elements: [
          { index: p.i, role: 'subject' },
          { index: p.trigger, role: 'trigger' },
        ],
        measurements: {
          distancePx: round2(gap),
          popupRect: roundRect(p.rect),
          triggerRect: roundRect(tr.rect),
          popupPosition: p.style.position,
          containingBlock: (() => {
            const cb = model.clipInfo(p.i).cbs[0];
            return cb !== undefined ? model.el(cb).selector : 'initial containing block';
          })(),
        },
        verify: [],
        consoleCheck: `(() => { const p = document.querySelector(${cssq(p.selector)}).getBoundingClientRect(), t = document.querySelector(${cssq(tr.selector)}).getBoundingClientRect(); return { popup: p, trigger: t, offsetParent: document.querySelector(${cssq(p.selector)}).offsetParent }; })()`,
        notes: [],
      });
    }
    return out;
  },
};
