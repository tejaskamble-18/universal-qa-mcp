import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Page } from 'playwright';
import type { EventRecorder } from './events.js';
import type { Observation } from './types.js';

let observerSource: string | null = null;
export function loadObserverSource(): string {
  observerSource ??= readFileSync(new URL('../inpage/observer.js', import.meta.url), 'utf8');
  return observerSource;
}

/** Route with volatile segments (numbers, UUIDs, long hex) replaced, for state fingerprints. */
export function normalizeRoute(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(s) || /^[0-9a-f]{16,}$/i.test(s) ? ':id' : s))
      .join('/');
    return `${u.origin}${path}`;
  } catch {
    return url;
  }
}

/**
 * Abstract UI state identity: route + the set of visible control signatures,
 * open overlays, expanded/selected controls and headings. Excludes volatile text
 * (numbers are normalised) and transient alerts.
 */
export function fingerprint(o: Omit<Observation, 'fingerprint' | 'route'>): string {
  const sig = [...new Set(o.controls.filter((c) => c.enabled).map((c) => c.signature))].sort();
  const open = o.overlays.map((x) => `${x.role}:${x.name.toLowerCase().replace(/\d+/g, '#')}`).sort();
  const toggled = o.controls
    .filter((c) => c.state.expanded === true || c.state.selected === true)
    .map((c) => c.signature)
    .sort();
  const heads = o.headings.map((h) => h.toLowerCase().replace(/\d+/g, '#'));
  return createHash('sha1')
    .update(JSON.stringify({ r: normalizeRoute(o.url), sig, open, toggled, heads }))
    .digest('hex')
    .slice(0, 12);
}

export async function ensureObserver(page: Page): Promise<void> {
  await page.evaluate(loadObserverSource()).catch(() => undefined);
}

/** Observe the page; HTTP-level signals (401/403/429 on the document) are merged into the challenge. */
export async function observe(page: Page, recorder: EventRecorder | null, maxControls = 400): Promise<Observation> {
  await ensureObserver(page);
  const raw = (await page.evaluate((m) => (window as any).__uqaObs.observe({ maxControls: m }), maxControls)) as Omit<
    Observation,
    'fingerprint' | 'route'
  >;
  let challenge = raw.challenge;
  if (!challenge && recorder) {
    const doc = [...recorder.events]
      .reverse()
      .find((e) => e.kind === 'request' && e.record.resourceType === 'document' && e.record.url.split('#')[0] === raw.url.split('#')[0]);
    const status = doc && doc.kind === 'request' ? doc.record.status : null;
    if (status === 403 || status === 429) {
      challenge = { kind: 'blocked', reason: `The document responded HTTP ${status}.`, evidence: `HTTP ${status} ${raw.url}` };
    } else if (status === 401) {
      challenge = { kind: 'auth', reason: 'The document responded HTTP 401 (authentication required).', evidence: `HTTP 401 ${raw.url}` };
    }
  }
  return { ...raw, challenge, route: normalizeRoute(raw.url), fingerprint: fingerprint(raw) };
}

export async function mutationCount(page: Page): Promise<number> {
  return (await page.evaluate(() => (window as any).__uqaObs?.mutations ?? 0).catch(() => 0)) as number;
}

/**
 * Wait until the UI is quiet: no in-flight requests and no DOM mutations for
 * `quietMs`, bounded by `timeoutMs`. Reports what was still pending on timeout.
 */
export async function settle(
  page: Page,
  recorder: EventRecorder,
  opts: { quietMs?: number; timeoutMs?: number } = {},
): Promise<{ settled: boolean; waitedMs: number; pending: string[]; mutating: boolean }> {
  const quietMs = opts.quietMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 6000;
  const start = Date.now();
  let lastActivity = start;
  let lastMut = await mutationCount(page);
  let mutating = false;
  for (;;) {
    await page.waitForTimeout(50);
    const mut = await mutationCount(page);
    const pending = recorder.pending();
    mutating = mut !== lastMut;
    if (mutating || pending.length) {
      lastActivity = Date.now();
      lastMut = mut;
    }
    if (Date.now() - lastActivity >= quietMs) return { settled: true, waitedMs: Date.now() - start, pending: [], mutating: false };
    if (Date.now() - start >= timeoutMs) return { settled: false, waitedMs: Date.now() - start, pending: recorder.pending(), mutating };
  }
}
