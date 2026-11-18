import { type Candidate, type Detector, cssq } from '../candidate.js';
import { bottom, cluster1d, right, round2 } from '../geometry.js';
import type { SnapshotModel } from '../model.js';
import type { ElementRecord } from '../snapshot-types.js';

export interface LayoutGroup {
  parent: number;
  axis: 'row' | 'column';
  /** Sorted along the main axis. */
  members: number[];
}

const SKIP_DISPLAY = /^(inline|contents|table|table-row|table-cell|table-row-group|table-header-group|table-footer-group|table-column|table-caption|list-item)$/;

function eligible(e: ElementRecord): boolean {
  const f = e.flags;
  return (
    f.visible && f.rendered && !f.srOnly && !f.ignored && !f.popup && !f.topLayer &&
    !SKIP_DISPLAY.test(e.style.display) &&
    (e.style.position === 'static' || e.style.position === 'relative') &&
    e.style.float === 'none' &&
    e.rect.w >= 4 && e.rect.h >= 4
  );
}

function overlap1d(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

/** Rows (and single columns) of >= 3 same-signature siblings. */
export function layoutGroups(model: SnapshotModel): LayoutGroup[] {
  const out: LayoutGroup[] = [];
  for (const parent of model.els) {
    if (!parent.flags.visible) continue;
    const kids = (model.children[parent.i] ?? []).filter((k) => eligible(model.el(k)));
    if (kids.length < 3) continue;
    const bySig = new Map<string, number[]>();
    for (const k of kids) {
      const sig = model.signature(k);
      const list = bySig.get(sig) ?? [];
      list.push(k);
      bySig.set(sig, list);
    }
    for (const members of bySig.values()) {
      if (members.length < 3) continue;
      const rects = new Map(members.map((m) => [m, model.el(m).rect]));
      const byTop = [...members].sort((a, b) => rects.get(a)!.y - rects.get(b)!.y);
      const rows: number[][] = [];
      for (const m of byTop) {
        const r = rects.get(m)!;
        const row = rows.find((rw) => {
          const f = rects.get(rw[0]!)!;
          return overlap1d(f.y, bottom(f), r.y, bottom(r)) >= 0.5 * Math.min(f.h, r.h);
        });
        if (row) row.push(m);
        else rows.push([m]);
      }
      let stacked = true;
      for (const row of rows) {
        if (row.length >= 3) {
          out.push({ parent: parent.i, axis: 'row', members: row.sort((a, b) => rects.get(a)!.x - rects.get(b)!.x) });
        }
        if (row.length > 1) stacked = false;
      }
      if (stacked && rows.length >= 3) {
        const first = rects.get(byTop[0]!)!;
        const col = byTop.every((m) => {
          const r = rects.get(m)!;
          return overlap1d(first.x, right(first), r.x, right(r)) >= 0.5 * Math.min(first.w, r.w);
        });
        if (col) out.push({ parent: parent.i, axis: 'column', members: byTop });
      }
    }
  }
  return out;
}

const STYLE_KEYS = ['margin', 'padding', 'border', 'position', 'transform'] as const;

function styleDiff(model: SnapshotModel, subject: number, peers: number[]): Record<string, { subject: unknown; peers: unknown }> {
  const diff: Record<string, { subject: unknown; peers: unknown }> = {};
  const s = model.el(subject).style;
  for (const key of STYLE_KEYS) {
    const sv = JSON.stringify(s[key]);
    const pv = peers.map((p) => JSON.stringify(model.el(p).style[key]));
    const allSame = pv.every((v) => v === pv[0]);
    if (allSame && pv[0] !== sv) diff[key] = { subject: s[key], peers: model.el(peers[0]!).style[key] };
  }
  return diff;
}

export const misalignmentDetector: Detector = {
  category: 'misalignment',
  description:
    'In a row/column of same-kind siblings, one or two items sit 2–16px off the alignment line the others share (top/centre/bottom or left/centre/right). ' +
    'Reported as potential: geometry proves the offset, not that it is unintended.',
  run({ model, t }) {
    const out: Candidate[] = [];
    for (const g of layoutGroups(model)) {
      const rects = g.members.map((m) => model.el(m).rect);
      const lines =
        g.axis === 'row'
          ? { top: rects.map((r) => r.y), center: rects.map((r) => r.y + r.h / 2), bottom: rects.map((r) => bottom(r)) }
          : { left: rects.map((r) => r.x), center: rects.map((r) => r.x + r.w / 2), right: rects.map((r) => right(r)) };
      let best: { line: string; clusters: ReturnType<typeof cluster1d>; values: number[] } | null = null;
      let aligned = false;
      for (const [line, values] of Object.entries(lines)) {
        const clusters = cluster1d(values, t.alignTolerancePx);
        if (clusters[0]!.members.length === values.length) {
          aligned = true;
          break;
        }
        if (!best || clusters[0]!.members.length > best.clusters[0]!.members.length) best = { line, clusters, values };
      }
      if (aligned || !best) continue;
      const n = g.members.length;
      const main = best.clusters[0]!;
      if (main.members.length < Math.max(2, Math.ceil(0.6 * n))) continue;
      const outliers = best.values
        .map((v, k) => ({ k, dev: v - main.mean }))
        .filter(({ k }) => !main.members.includes(k));
      if (outliers.length > 2) continue;
      if (outliers.some((o) => Math.abs(o.dev) > t.alignMaxDeviationPx)) continue;
      for (const o of outliers) {
        if (Math.abs(o.dev) < t.alignMinDeviationPx) continue;
        const subject = g.members[o.k]!;
        const peers = main.members.map((k) => g.members[k]!);
        const diff = styleDiff(model, subject, peers);
        const explained = Object.keys(diff).length > 0;
        out.push({
          category: 'misalignment',
          key: `misalignment|${model.el(subject).selector}`,
          title: `Item is ${Math.abs(round2(o.dev))}px off its siblings' ${best.line} alignment`,
          description:
            `In ${model.label(g.parent)}, ${main.members.length} of ${n} ${g.axis} items share a ${best.line} edge at ` +
            `${round2(main.mean)}px; ${model.label(subject)} is at ${round2(best.values[o.k]!)}px (${o.dev > 0 ? '+' : ''}${round2(o.dev)}px).` +
            (explained ? ` Its computed ${Object.keys(diff).join(', ')} differ from its siblings'.` : ''),
          severity: 'low',
          confidence: explained ? 0.75 : 0.6,
          maxStatus: 'potential',
          elements: [
            { index: subject, role: 'subject' },
            ...peers.slice(0, 2).map((p) => ({ index: p, role: 'related' as const })),
            { index: g.parent, role: 'container' },
          ],
          measurements: {
            axis: g.axis,
            alignmentLine: best.line,
            expectedPx: round2(main.mean),
            actualPx: round2(best.values[o.k]!),
            deviationPx: round2(o.dev),
            groupSize: n,
            alignedCount: main.members.length,
            styleDifferences: diff,
          },
          verify: [],
          consoleCheck: `[...document.querySelector(${cssq(model.el(g.parent).selector)}).children].map(e => Math.round(e.getBoundingClientRect().${g.axis === 'row' ? 'top' : 'left'} * 100) / 100)`,
          notes: ['Design-consistency heuristic: confirm whether the offset is intended.'],
        });
      }
    }
    return out;
  },
};

export const spacingDetector: Detector = {
  category: 'inconsistent-spacing',
  description:
    'In a row/column of >= 4 same-kind siblings, most gaps are equal but one or two differ by >= max(4px, 25%). Reported as potential.',
  run({ model, t }) {
    const out: Candidate[] = [];
    for (const g of layoutGroups(model)) {
      if (g.members.length < 4) continue;
      const rects = g.members.map((m) => model.el(m).rect);
      const gaps: number[] = [];
      for (let k = 1; k < rects.length; k++) {
        const a = rects[k - 1]!;
        const b = rects[k]!;
        gaps.push(g.axis === 'row' ? b.x - right(a) : b.y - bottom(a));
      }
      if (gaps.some((v) => v < -0.5)) continue; // overlapping items: the overlap detector owns this
      const clusters = cluster1d(gaps, t.spacingTolerancePx);
      const main = clusters[0]!;
      if (main.members.length < Math.max(2, Math.ceil(0.6 * gaps.length))) continue;
      const outliers = gaps.map((v, k) => ({ k, v })).filter(({ k }) => !main.members.includes(k));
      if (!outliers.length || outliers.length > 2) continue;
      for (const o of outliers) {
        const dev = o.v - main.mean;
        if (Math.abs(dev) < Math.max(t.spacingMinDeviationPx, t.spacingMinRelative * main.mean)) continue;
        const a = g.members[o.k]!;
        const b = g.members[o.k + 1]!;
        const sa = model.el(a).style.margin;
        const sb = model.el(b).style.margin;
        const typical = g.members[main.members[0]!]!;
        out.push({
          category: 'inconsistent-spacing',
          key: `inconsistent-spacing|${model.el(g.parent).selector}|${model.el(a).selector}`,
          title: `Gap of ${round2(o.v)}px where siblings use ${round2(main.mean)}px`,
          description:
            `In ${model.label(g.parent)} (${g.axis}, ${g.members.length} items) ${main.members.length} of ${gaps.length} gaps are ` +
            `${round2(main.mean)}px, but the gap between ${model.label(a)} and ${model.label(b)} is ${round2(o.v)}px.`,
          severity: 'low',
          confidence: 0.65,
          maxStatus: 'potential',
          elements: [
            { index: a, role: 'subject' },
            { index: b, role: 'subject' },
            { index: g.parent, role: 'container' },
          ],
          measurements: {
            axis: g.axis,
            gapPx: round2(o.v),
            typicalGapPx: round2(main.mean),
            allGapsPx: gaps.map(round2),
            parentGap: { row: model.el(g.parent).style.rowGap, column: model.el(g.parent).style.columnGap },
            margins: { [model.el(a).selector]: sa, [model.el(b).selector]: sb, typical: model.el(typical).style.margin },
          },
          verify: [],
          consoleCheck: `(() => { const k = [...document.querySelector(${cssq(model.el(g.parent).selector)}).children].map(e => e.getBoundingClientRect()); return k.slice(1).map((r, i) => Math.round((r.${g.axis === 'row' ? 'left' : 'top'} - k[i].${g.axis === 'row' ? 'right' : 'bottom'}) * 100) / 100); })()`,
          notes: ['Design-consistency heuristic: confirm whether the different gap is intended.'],
        });
      }
    }
    return out;
  },
};
