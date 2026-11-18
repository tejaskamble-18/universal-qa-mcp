import { PNG } from 'pngjs';
import type { ElementRoleT } from '../report/schema.js';
import type { Rect } from '../engine/snapshot-types.js';

export function decode(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}

export function encode(png: PNG): Buffer {
  return PNG.sync.write(png);
}

/**
 * Count pixels whose max channel delta exceeds `threshold`. Images of
 * different sizes are compared over their common area; the size difference
 * itself counts as changed.
 */
export function diffCount(a: PNG, b: PNG, threshold: number): number {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  let changed = Math.abs(a.width * a.height - b.width * b.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      const d = Math.max(
        Math.abs(a.data[ia]! - b.data[ib]!),
        Math.abs(a.data[ia + 1]! - b.data[ib + 1]!),
        Math.abs(a.data[ia + 2]! - b.data[ib + 2]!),
      );
      if (d > threshold) changed++;
    }
  }
  return changed;
}

export const ROLE_COLORS: Record<ElementRoleT, [number, number, number]> = {
  subject: [230, 25, 75],
  target: [240, 50, 230],
  obstructor: [0, 130, 200],
  container: [245, 130, 48],
  trigger: [60, 180, 75],
  related: [128, 128, 128],
};

/** Draw outlined rectangles (in image pixel coordinates) onto a copy of the image. */
export function annotate(png: PNG, boxes: { rect: Rect; role: ElementRoleT }[], thickness = 2): PNG {
  const out = new PNG({ width: png.width, height: png.height });
  png.data.copy(out.data);
  const put = (x: number, y: number, c: [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
    const i = (y * out.width + x) * 4;
    out.data[i] = c[0];
    out.data[i + 1] = c[1];
    out.data[i + 2] = c[2];
    out.data[i + 3] = 255;
  };
  // Draw lower-priority roles first so subjects end up on top.
  const order: ElementRoleT[] = ['related', 'container', 'trigger', 'obstructor', 'target', 'subject'];
  const sorted = [...boxes].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  for (const { rect, role } of sorted) {
    const c = ROLE_COLORS[role];
    const x1 = Math.round(rect.x);
    const y1 = Math.round(rect.y);
    const x2 = Math.round(rect.x + rect.w) - 1;
    const y2 = Math.round(rect.y + rect.h) - 1;
    for (let t = 0; t < thickness; t++) {
      for (let x = x1; x <= x2; x++) {
        put(x, y1 + t, c);
        put(x, y2 - t, c);
      }
      for (let y = y1; y <= y2; y++) {
        put(x1 + t, y, c);
        put(x2 - t, y, c);
      }
    }
  }
  return out;
}
