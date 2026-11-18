import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserManager } from '../../src/browser/session.js';
import type { Report } from '../../src/report/schema.js';
import { ALL_KEYS, ARTIFACTS, audit, oneLine } from '../helpers/audit.js';
import { startFixtureServer } from '../helpers/fixture-server.js';

const CLEAN_PAGES = ['clean/layout.html', 'clean/overlays.html', 'clean/modal.html'];

/**
 * False-positive control: pages full of valid-but-tricky patterns must produce
 * zero findings (verified or potential) at every viewport and zoom level, and
 * the intentional-pattern rules must actually have been exercised.
 */
describe('clean fixtures: no false positives', () => {
  const browsers = new BrowserManager();
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  const reports = new Map<string, Report>();

  beforeAll(async () => {
    server = await startFixtureServer();
    for (const page of CLEAN_PAGES) reports.set(page, await audit(browsers, server.url(page)));
  }, 600_000);

  afterAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(
      join(ARTIFACTS, 'clean-summary.json'),
      JSON.stringify(
        [...reports].map(([page, r]) => ({
          page,
          runId: r.runId,
          findings: r.findings.map(oneLine),
          suppressedByRule: r.suppressed.reduce<Record<string, number>>((m, s) => ({ ...m, [`${s.category}/${s.rule}`]: (m[`${s.category}/${s.rule}`] ?? 0) + 1 }), {}),
          elementsRecorded: r.coverage.elementsRecorded,
        })),
        null,
        2,
      ),
    );
    await browsers.close();
    await server?.close();
  });

  for (const page of CLEAN_PAGES) {
    it(`${page}: zero findings across ${ALL_KEYS.join(', ')}`, () => {
      const r = reports.get(page)!;
      expect(r.coverage.configsCompleted).toBe(ALL_KEYS.length);
      expect(r.blocked).toEqual([]);
      expect(r.findings.map(oneLine)).toEqual([]);
    });
  }

  it('exercised the intentional-pattern rules (the zero result is not vacuous)', () => {
    const fired = new Set([...reports.values()].flatMap((r) => r.suppressed.map((s) => `${s.category}/${s.rule}`)));
    for (const rule of [
      'overlap/overlay-on-media', // caption over hero image
      'overlap/intentional-stack', // avatar group
      'text-clipping/permitted-truncation', // ellipsis + line-clamp
      'offscreen-target/reachable-on-focus', // skip link
      'overlap/intentional-overlay', // open dropdown/tooltip over content
      'text-clipping/hidden-content', // aria-hidden carousel slides
      'text-clipping/collapsed-container', // closed accordion
      'obstructed-target/covered-by-open-popup', // link under the open menu
      'obstructed-target/covered-by-open-modal', // page behind modal + backdrop
      'responsive-layout/disclosure-present', // desktop nav replaced by a menu button
    ]) {
      expect(fired, `expected rule ${rule} to fire; fired: ${[...fired].join(', ')}`).toContain(rule);
    }
  });

  it('measured a meaningful number of elements on every page', () => {
    for (const r of reports.values()) expect(r.coverage.elementsRecorded).toBeGreaterThan(40);
  });
});
