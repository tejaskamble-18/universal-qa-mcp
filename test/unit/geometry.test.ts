import { describe, expect, it } from 'vitest';
import {
  clipRegionFrom,
  cluster1d,
  gapBetween,
  hiddenOutside,
  intersect,
  protrusion,
  subtractRegion,
  UNBOUNDED,
} from '../../src/engine/geometry.js';
import { r } from '../helpers/synthetic.js';

describe('geometry', () => {
  it('intersects rects and rejects edge-touching ones', () => {
    expect(intersect(r(0, 0, 10, 10), r(5, 5, 10, 10))).toEqual(r(5, 5, 5, 5));
    expect(intersect(r(0, 0, 10, 10), r(10, 0, 10, 10))).toBeNull();
  });

  it('measures hidden area and extents against a one-axis clip', () => {
    const region = clipRegionFrom(r(0, 0, 100, 20), { x: false, y: true });
    const h = hiddenOutside([r(0, 0, 50, 20), r(0, 20, 50, 20)], region);
    expect(h.hiddenFraction).toBeCloseTo(0.5);
    expect(h.maxHiddenY).toBe(20);
    expect(h.maxHiddenX).toBe(0);
    expect(h.hiddenRects).toEqual([r(0, 20, 50, 20)]);
  });

  it('treats an unbounded region as hiding nothing', () => {
    expect(hiddenOutside([r(-50, -50, 10, 10)], UNBOUNDED).hiddenArea).toBe(0);
  });

  it('subtracts a region into the outside strips', () => {
    const parts = subtractRegion(r(0, 0, 100, 100), clipRegionFrom(r(0, 0, 60, 100), { x: true, y: true }));
    expect(parts).toEqual([r(60, 0, 40, 100)]);
  });

  it('computes gaps and protrusion', () => {
    expect(gapBetween(r(0, 0, 10, 10), r(13, 0, 10, 10))).toBe(3);
    expect(gapBetween(r(0, 0, 10, 10), r(5, 5, 10, 10))).toBe(0);
    expect(protrusion(r(0, 0, 100, 100), r(90, 50, 30, 80))).toMatchObject({ right: 20, bottom: 30, max: 30 });
  });

  it('clusters values with tolerance, largest cluster first', () => {
    const c = cluster1d([12, 12, 32, 12.4], 1);
    expect(c[0]!.members.sort()).toEqual([0, 1, 3]);
    expect(c[1]!.members).toEqual([2]);
  });
});
