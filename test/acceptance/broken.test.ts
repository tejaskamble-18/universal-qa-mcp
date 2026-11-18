import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserManager } from '../../src/browser/session.js';
import type { Report } from '../../src/report/schema.js';
import { ALL_KEYS, ARTIFACTS, audit, involves, oneLine } from '../helpers/audit.js';
import { startFixtureServer } from '../helpers/fixture-server.js';
import { BROKEN_PAGES, EXPECTED } from './expectations.js';

/**
 * Acceptance: every deliberately broken pattern is detected with the expected
 * category, elements, status and viewport range — and every reported finding
 * points at a deliberately broken region (precision on the broken pages).
 */
describe('broken fixtures: defects are detected with evidence', () => {
  const browsers = new BrowserManager();
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  const reports = new Map<string, Report>();

  beforeAll(async () => {
    server = await startFixtureServer();
    for (const page of BROKEN_PAGES) reports.set(page, await audit(browsers, server.url(page)));
  }, 600_000);

  afterAll(async () => {
    const summary = EXPECTED.map((e) => {
      const r = reports.get(e.page);
      const hits = r?.findings.filter((f) => e.categories.includes(f.category) && involves(f, e.involves)) ?? [];
      return { id: e.id, page: e.page, detected: hits.length > 0, findings: hits.map(oneLine) };
    });
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(
      join(ARTIFACTS, 'broken-summary.json'),
      JSON.stringify({ summary, reports: [...reports.values()].map((r) => ({ url: r.target.url, runId: r.runId, findings: r.findings.map(oneLine) })) }, null, 2),
    );
    await browsers.close();
    await server?.close();
  });

  for (const e of EXPECTED) {
    it(`detects ${e.id} (${e.page})`, () => {
      const report = reports.get(e.page)!;
      expect(report.coverage.configsCompleted).toBe(ALL_KEYS.length);
      const hits = report.findings.filter((f) => e.categories.includes(f.category) && involves(f, e.involves));
      expect(hits, `no ${e.categories.join('/')} finding involving ${e.involves.join(', ')}; got:\n${report.findings.map(oneLine).join('\n')}`).not.toHaveLength(0);
      const best = hits[0]!;
      expect(e.statuses).toContain(best.status);

      const reproduced = new Set(hits.flatMap((f) => f.occurrences.map((o) => o.configKey)));
      for (const k of e.reproducesIn ?? []) expect(reproduced.has(k), `${e.id} should reproduce at ${k}`).toBe(true);
      for (const k of e.absentIn ?? []) expect(reproduced.has(k), `${e.id} should not be reported at ${k}`).toBe(false);

      // Every finding carries the evidence the report promises.
      for (const f of hits) {
        expect(f.elements.length).toBeGreaterThan(0);
        expect(f.page.url).toBe(report.target.url);
        expect(f.config.browserVersion).not.toBe('');
        expect(Object.keys(f.measurements).length).toBeGreaterThan(0);
        expect(f.reproduction.steps.length).toBeGreaterThanOrEqual(4);
        expect(f.reproduction.consoleCheck.length).toBeGreaterThan(10);
        expect(f.confidence).toBeGreaterThan(0);
        if (f.status === 'verified') {
          // Verified means re-confirmed in the live page: a pixel/interaction/scroll check, a horizontal-scroll
          // proof, or (when none is physically possible) a stable live re-measurement that says so explicitly.
          const ev = f.evidence;
          const live = ev.visual.length + ev.hitTests.length + (ev.focusProbe ? 1 : 0) + (ev.scrollProbe ? 1 : 0);
          const hscroll = typeof f.measurements.maxScrollX === 'number';
          const geometryOnly = ev.stability?.stable === true && f.notes.some((n) => n.startsWith('Verified by exact geometry'));
          expect(live > 0 || hscroll || geometryOnly, `${oneLine(f)} has no live verification evidence`).toBe(true);
          expect(ev.stability?.stable).toBe(true);
        }
      }
      expect(hits.some((f) => f.evidence.screenshot || f.evidence.fullPageScreenshot)).toBe(true);
    });
  }

  it('reports nothing outside the deliberately broken regions (precision)', async () => {
    const browser = await chromium.launch();
    const stray: string[] = [];
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      for (const [path, report] of reports) {
        await page.goto(server.url(path));
        for (const f of report.findings) {
          const selectors = f.elements.map((e) => e.selector);
          const inDefect = await page.evaluate(
            (sels) => sels.some((s) => {
              try {
                return !!document.querySelector(s)?.closest('[data-defect]');
              } catch {
                return false;
              }
            }),
            selectors,
          );
          if (!inDefect) stray.push(`${path}: ${oneLine(f)}`);
        }
      }
    } finally {
      await browser.close();
    }
    expect(stray, stray.join('\n')).toEqual([]);
  });

  it('recognises the background control behind an open modal as intentional', () => {
    const r = reports.get('broken/modal.html')!;
    expect(r.findings.some((f) => f.elements.some((e) => e.selector === '#bg-btn'))).toBe(false);
    expect(r.suppressed.some((s) => s.rule === 'covered-by-open-modal' && s.selectors.includes('#bg-btn'))).toBe(true);
  });
});
