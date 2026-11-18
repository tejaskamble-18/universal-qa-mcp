import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../../src/engine/candidate.js';
import { textClippingDetector } from '../../src/engine/detectors/clipping.js';
import { misalignmentDetector, spacingDetector } from '../../src/engine/detectors/consistency.js';
import { overlapDetector } from '../../src/engine/detectors/overlap.js';
import { containerOverflowDetector, viewportOverflowDetector } from '../../src/engine/detectors/overflow.js';
import { SnapshotModel } from '../../src/engine/model.js';
import { r, synth } from '../helpers/synthetic.js';

const run = (d: { run: (c: { model: SnapshotModel; t: typeof DEFAULT_THRESHOLDS }) => unknown[] }, snap: ReturnType<typeof synth>) =>
  d.run({ model: new SnapshotModel(snap), t: DEFAULT_THRESHOLDS }) as { suppressed?: { rule: string }; elements: { index: number }[]; key: string }[];

const button = (parent: number, x: number, extra: Record<string, unknown> = {}) => ({
  parent,
  tag: 'button',
  rect: r(x, 10, 80, 32),
  flags: { interactive: true, interactiveSource: 'semantic' as const, focusable: true },
  ...extra,
});

describe('overlap detector', () => {
  it('reports two overlapping buttons', () => {
    const out = run(overlapDetector, synth([{ parent: 1, rect: r(0, 0, 500, 60) }, button(2, 10), button(2, 60)]));
    expect(out).toHaveLength(1);
    expect(out[0]!.suppressed).toBeUndefined();
  });

  it('does not mistake a row of buttons with one overlap for an intentional stack (regression)', () => {
    const out = run(
      overlapDetector,
      synth([{ parent: 1, rect: r(0, 0, 500, 60) }, button(2, 0), button(2, 88), button(2, 136), button(2, 224)]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.suppressed).toBeUndefined();
  });

  it('suppresses a consistent avatar stack', () => {
    const img = (x: number) => ({ parent: 2, tag: 'img', rect: r(x, 0, 32, 32), flags: { replaced: true } });
    const out = run(overlapDetector, synth([{ parent: 1, rect: r(0, 0, 500, 40) }, img(0), img(22), img(44), img(66)]));
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.suppressed?.rule === 'intentional-stack')).toBe(true);
  });

  it('suppresses a caption fully inside an image', () => {
    const out = run(
      overlapDetector,
      synth([
        { parent: 1, rect: r(0, 0, 600, 200), style: { position: 'relative' } },
        { parent: 2, tag: 'img', rect: r(0, 0, 600, 200), flags: { replaced: true } },
        { parent: 2, tag: 'p', rect: r(16, 160, 200, 24), style: { position: 'absolute' }, text: [r(20, 162, 180, 20)] },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.suppressed?.rule).toBe('overlay-on-media');
  });
});

describe('text clipping detector', () => {
  const clipped = (textOverflow: string) =>
    synth([
      {
        parent: 1,
        tag: 'h3',
        rect: r(0, 0, 100, 22),
        style: { overflowX: 'hidden', overflowY: 'hidden', whiteSpace: 'nowrap', textOverflow },
        text: [r(0, 2, 260, 18)],
      },
    ]);

  it('reports text cut by its own overflow box', () => {
    const out = run(textClippingDetector, clipped('clip'));
    expect(out).toHaveLength(1);
    expect(out[0]!.suppressed).toBeUndefined();
  });

  it('treats ellipsis truncation as permitted', () => {
    const out = run(textClippingDetector, clipped('ellipsis'));
    expect(out).toHaveLength(1);
    expect(out[0]!.suppressed?.rule).toBe('permitted-truncation');
  });

  it('treats a collapsed (0px) container as intentional', () => {
    const out = run(
      textClippingDetector,
      synth([
        { parent: 1, rect: r(0, 0, 300, 0), style: { overflowX: 'hidden', overflowY: 'hidden' }, flags: { visible: false } },
        { parent: 2, tag: 'p', rect: r(0, 0, 300, 20), text: [r(0, 0, 250, 20)] },
      ]),
    );
    expect(out.every((c) => c.suppressed?.rule === 'collapsed-container')).toBe(true);
  });
});

describe('overflow detectors', () => {
  it('attributes horizontal page overflow to the element escaping its parent, not its passengers', () => {
    const snap = synth(
      [
        { parent: 1, id: 'banner', rect: r(0, 0, 960, 100) },
        { parent: 2, tag: 'p', rect: r(0, 0, 960, 20), text: [r(0, 0, 300, 20)] },
      ],
      { w: 375, h: 800 },
      { scrollWidth: 960 },
    );
    const out = run(viewportOverflowDetector, snap);
    expect(out).toHaveLength(1);
    expect(out[0]!.elements.map((e) => e.index)).toEqual([2]);
  });

  it('ignores content contained by an overflow-x:auto wrapper', () => {
    const snap = synth(
      [
        { parent: 1, rect: r(0, 0, 375, 200), style: { overflowX: 'auto', overflowY: 'auto' } },
        { parent: 2, tag: 'table', rect: r(0, 0, 900, 200) },
      ],
      { w: 375, h: 800 },
    );
    expect(run(viewportOverflowDetector, snap)).toHaveLength(0);
  });

  it('reports in-flow content spilling out of a fixed-height card but not an absolutely positioned badge', () => {
    const snap = synth([
      { parent: 1, id: 'card', rect: r(0, 0, 300, 180), scroll: { sh: 240, ch: 180 } },
      { parent: 2, tag: 'p', rect: r(10, 150, 280, 80), text: [r(10, 150, 270, 20), r(10, 210, 270, 20)] },
      { parent: 2, tag: 'span', rect: r(290, -8, 20, 20), style: { position: 'absolute' }, text: [r(292, -6, 10, 16)] },
    ]);
    const out = run(containerOverflowDetector, snap);
    expect(out).toHaveLength(1);
    expect(out[0]!.elements.map((e) => e.index)).toEqual([2, 3]);
  });
});

describe('consistency detectors', () => {
  const row = (tops: number[], heights: number[] = tops.map(() => 40), xs: number[] = tops.map((_, k) => k * 100)) =>
    synth([
      { parent: 1, rect: r(0, 0, 600, 100) },
      ...tops.map((y, k) => ({ parent: 2, classes: 'card', rect: r(xs[k]!, y, 80, heights[k]!) })),
    ]);

  it('flags an item a few px off its row', () => {
    const out = run(misalignmentDetector, row([10, 10, 17, 10]));
    expect(out).toHaveLength(1);
    expect(out[0]!.elements[0]!.index).toBe(5);
  });

  it('accepts a centre-aligned row of different heights', () => {
    expect(run(misalignmentDetector, row([20, 10, 0, 15], [40, 60, 80, 50]))).toHaveLength(0);
  });

  it('flags one inconsistent gap among equal gaps', () => {
    const xs = [0, 92, 184, 296, 388];
    const out = run(spacingDetector, row([10, 10, 10, 10, 10], undefined, xs));
    expect(out).toHaveLength(1);
  });
});
