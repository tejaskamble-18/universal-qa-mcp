import type { Rect } from './snapshot-types.js';

export const EMPTY: Rect = { x: 0, y: 0, w: 0, h: 0 };

export const right = (r: Rect): number => r.x + r.w;
export const bottom = (r: Rect): number => r.y + r.h;
export const area = (r: Rect | null | undefined): number => (r && r.w > 0 && r.h > 0 ? r.w * r.h : 0);
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

/** Intersection of two rects, or null when they do not overlap with positive area. */
export function intersect(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(right(a), right(b));
  const y2 = Math.min(bottom(a), bottom(b));
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function union(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, right(r));
    y2 = Math.max(y2, bottom(r));
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function contains(outer: Rect, inner: Rect, tolerance = 0): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    right(inner) <= right(outer) + tolerance &&
    bottom(inner) <= bottom(outer) + tolerance
  );
}

export function pointIn(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= right(r) && y >= r.y && y <= bottom(r);
}

/** Shortest distance between two rects (0 when they touch or overlap). */
export function gapBetween(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(right(a), right(b)));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(bottom(a), bottom(b)));
  return Math.hypot(dx, dy);
}

/** How far `inner` sticks out of `outer` on each side (non-negative px). */
export function protrusion(outer: Rect, inner: Rect): { top: number; right: number; bottom: number; left: number; max: number } {
  const top = Math.max(0, outer.y - inner.y);
  const left = Math.max(0, outer.x - inner.x);
  const r = Math.max(0, right(inner) - right(outer));
  const b = Math.max(0, bottom(inner) - bottom(outer));
  return { top, right: r, bottom: b, left, max: Math.max(top, r, b, left) };
}

/**
 * An axis-aligned clip region. Each axis is an interval; `null` bounds mean
 * "unbounded" on that side (e.g. an ancestor clipping only on the y axis).
 */
export interface ClipRegion {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export const UNBOUNDED: ClipRegion = { x1: -Infinity, x2: Infinity, y1: -Infinity, y2: Infinity };

export function clipRegionFrom(r: Rect, axes: { x: boolean; y: boolean }): ClipRegion {
  return {
    x1: axes.x ? r.x : -Infinity,
    x2: axes.x ? right(r) : Infinity,
    y1: axes.y ? r.y : -Infinity,
    y2: axes.y ? bottom(r) : Infinity,
  };
}

export function intersectRegions(a: ClipRegion, b: ClipRegion): ClipRegion {
  return { x1: Math.max(a.x1, b.x1), x2: Math.min(a.x2, b.x2), y1: Math.max(a.y1, b.y1), y2: Math.min(a.y2, b.y2) };
}

export function clipRect(r: Rect, region: ClipRegion): Rect | null {
  const x1 = Math.max(r.x, region.x1);
  const y1 = Math.max(r.y, region.y1);
  const x2 = Math.min(right(r), region.x2);
  const y2 = Math.min(bottom(r), region.y2);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function isUnbounded(region: ClipRegion): boolean {
  return region.x1 === -Infinity && region.x2 === Infinity && region.y1 === -Infinity && region.y2 === Infinity;
}

/**
 * Pixels of `rects` that fall outside `region`: total hidden area, and the
 * largest hidden extent along each axis.
 */
export function hiddenOutside(rects: readonly Rect[], region: ClipRegion): {
  totalArea: number;
  hiddenArea: number;
  hiddenFraction: number;
  maxHiddenX: number;
  maxHiddenY: number;
  hiddenRects: Rect[];
} {
  let totalArea = 0;
  let hiddenArea = 0;
  let maxHiddenX = 0;
  let maxHiddenY = 0;
  const hiddenRects: Rect[] = [];
  for (const r of rects) {
    const a = area(r);
    if (!a) continue;
    totalArea += a;
    const vis = clipRect(r, region);
    hiddenArea += a - area(vis);
    const hx = Math.max(0, region.x1 - r.x) + Math.max(0, right(r) - region.x2);
    const hy = Math.max(0, region.y1 - r.y) + Math.max(0, bottom(r) - region.y2);
    maxHiddenX = Math.max(maxHiddenX, Math.min(hx, r.w));
    maxHiddenY = Math.max(maxHiddenY, Math.min(hy, r.h));
    hiddenRects.push(...subtractRegion(r, region));
  }
  return {
    totalArea,
    hiddenArea,
    hiddenFraction: totalArea ? hiddenArea / totalArea : 0,
    maxHiddenX,
    maxHiddenY,
    hiddenRects,
  };
}

/** The parts of `r` outside `region`, as up to four non-overlapping rects. */
export function subtractRegion(r: Rect, region: ClipRegion): Rect[] {
  const out: Rect[] = [];
  const vis = clipRect(r, region);
  if (!vis) return area(r) ? [r] : [];
  if (vis.y > r.y) out.push({ x: r.x, y: r.y, w: r.w, h: vis.y - r.y });
  if (bottom(vis) < bottom(r)) out.push({ x: r.x, y: bottom(vis), w: r.w, h: bottom(r) - bottom(vis) });
  if (vis.x > r.x) out.push({ x: r.x, y: vis.y, w: vis.x - r.x, h: vis.h });
  if (right(vis) < right(r)) out.push({ x: right(vis), y: vis.y, w: right(r) - right(vis), h: vis.h });
  return out;
}

/** Overlap area of two rect lists (sum over pairs; inputs are assumed internally disjoint). */
export function overlapOfLists(a: readonly Rect[], b: readonly Rect[]): { area: number; largest: Rect | null } {
  let total = 0;
  let largest: Rect | null = null;
  for (const ra of a) {
    for (const rb of b) {
      const i = intersect(ra, rb);
      if (!i) continue;
      total += area(i);
      if (!largest || area(i) > area(largest)) largest = i;
    }
  }
  return { area: total, largest };
}

export function pad(r: Rect, p: number): Rect {
  return { x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p };
}

export function roundRect(r: Rect): Rect {
  return { x: round2(r.x), y: round2(r.y), w: round2(r.w), h: round2(r.h) };
}

/**
 * Cluster 1-D values with a tolerance. Returns clusters sorted by size
 * (largest first); each cluster carries its member indices and mean.
 */
export function cluster1d(values: readonly number[], tolerance: number): { members: number[]; mean: number }[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const clusters: { members: number[]; sum: number; min: number }[] = [];
  for (const { v, i } of order) {
    const last = clusters[clusters.length - 1];
    if (last && v - last.min <= tolerance) {
      last.members.push(i);
      last.sum += v;
    } else {
      clusters.push({ members: [i], sum: v, min: v });
    }
  }
  return clusters
    .map((c) => ({ members: c.members, mean: c.sum / c.members.length }))
    .sort((a, b) => b.members.length - a.members.length);
}
