import { describe, expect, it } from 'vitest';
import { SnapshotModel } from '../../src/engine/model.js';
import { r, synth } from '../helpers/synthetic.js';

describe('SnapshotModel clipping (containing-block aware)', () => {
  it('clips a static child by an overflow:hidden parent', () => {
    const m = new SnapshotModel(
      synth([
        { parent: 1, rect: r(0, 0, 100, 50), style: { overflowX: 'hidden', overflowY: 'hidden' } },
        { parent: 2, rect: r(0, 0, 100, 120) },
      ]),
    );
    expect(m.clipInfo(3).chain).toEqual([2]);
    expect(m.visibleRect(3)).toEqual(r(0, 0, 100, 50));
  });

  it('lets an absolutely positioned element escape an overflow:hidden box that is not its containing block', () => {
    const m = new SnapshotModel(
      synth([
        { parent: 1, rect: r(0, 0, 400, 400), style: { position: 'relative' } }, // 2: containing block
        { parent: 2, rect: r(0, 0, 100, 50), style: { overflowX: 'hidden', overflowY: 'hidden' } }, // 3: static clipper
        { parent: 3, rect: r(0, 40, 200, 200), style: { position: 'absolute' } }, // 4: dropdown
      ]),
    );
    expect(m.clipInfo(4).chain).toEqual([]);
    expect(m.visibleRect(4)).toEqual(r(0, 40, 200, 200));
  });

  it('clips an absolutely positioned element when the positioned ancestor itself clips', () => {
    const m = new SnapshotModel(
      synth([
        { parent: 1, rect: r(0, 0, 100, 50), style: { position: 'relative', overflowX: 'hidden', overflowY: 'hidden' } },
        { parent: 2, rect: r(0, 0, 100, 50) },
        { parent: 3, rect: r(0, 40, 200, 200), style: { position: 'absolute' } },
      ]),
    );
    expect(m.clipInfo(4).chain).toEqual([2]);
    expect(m.visibleRect(4)).toEqual(r(0, 40, 100, 10));
  });

  it('lets position:fixed escape ancestor clipping unless an ancestor establishes a fixed containing block', () => {
    const plain = new SnapshotModel(
      synth([
        { parent: 1, rect: r(0, 0, 100, 50), style: { overflowX: 'hidden', overflowY: 'hidden' } },
        { parent: 2, rect: r(0, 0, 300, 300), style: { position: 'fixed' } },
      ]),
    );
    expect(plain.clipInfo(3)).toMatchObject({ chain: [], fixedToViewport: true });

    const transformed = new SnapshotModel(
      synth([
        { parent: 1, rect: r(0, 0, 100, 50), style: { overflowX: 'hidden', overflowY: 'hidden', transform: true }, flags: { fixedCB: true } },
        { parent: 2, rect: r(0, 0, 300, 300), style: { position: 'fixed' } },
      ]),
    );
    expect(transformed.clipInfo(3)).toMatchObject({ chain: [2], fixedToViewport: false });
  });

  it('treats content left of the document origin as unreachable', () => {
    const m = new SnapshotModel(synth([{ parent: 1, rect: r(-150, 10, 100, 30) }]));
    const reach = m.reachableRegion(2);
    expect(reach.x1).toBe(0);
  });

  it('treats content inside a horizontal scroller as reachable even beyond the document width', () => {
    const m = new SnapshotModel(
      synth(
        [
          { parent: 1, rect: r(16, 0, 343, 200), style: { overflowX: 'auto', overflowY: 'auto' }, scroll: { sw: 900, sh: 200, cw: 343, ch: 200 } },
          { parent: 2, rect: r(800, 10, 50, 20) },
        ],
        { w: 375, h: 812 },
      ),
    );
    const reach = m.reachableRegion(3);
    expect(reach.x1).toBe(16);
    expect(reach.x2).toBe(916);
  });

  it('treats negative overflow of a scroll container as unreachable', () => {
    const m = new SnapshotModel(
      synth([
        { parent: 1, rect: r(100, 0, 200, 100), style: { overflowX: 'auto', overflowY: 'auto' }, scroll: { sw: 300, sh: 100 } },
        { parent: 2, rect: r(40, 10, 50, 20) },
      ]),
    );
    expect(m.reachableRegion(3).x1).toBe(100);
  });

  it('assigns overlay layers', () => {
    const m = new SnapshotModel(
      synth([
        { parent: 1, rect: r(0, 0, 100, 40), style: { position: 'fixed' } },
        { parent: 2, rect: r(0, 0, 50, 20) },
        { parent: 1, rect: r(0, 100, 200, 200), style: { position: 'absolute' }, flags: { popup: true } },
      ]),
    );
    expect(m.layer(3)).toEqual({ root: 2, kind: 'fixed' });
    expect(m.layer(4)).toEqual({ root: 4, kind: 'popup' });
    expect(m.inOverlay(4)).toBe(true);
  });
});
