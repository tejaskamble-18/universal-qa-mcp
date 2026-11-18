import { resolve } from 'node:path';
import type { BrowserManager, ConfigRequest } from '../../src/browser/session.js';
import { runAudit } from '../../src/engine/audit.js';
import type { Finding, Report } from '../../src/report/schema.js';
import { policyFromEnv } from '../../src/safety/policy.js';

export const ARTIFACTS = resolve(import.meta.dirname, '..', '..', '.qa-artifacts', 'acceptance');

/** Mobile, tablet, desktop, and desktop at 200% browser zoom (CSS viewport 640×400). */
export const ACCEPTANCE_CONFIGS: ConfigRequest[] = [
  { width: 375, height: 812, zoom: 1, colorScheme: 'light' },
  { width: 768, height: 1024, zoom: 1, colorScheme: 'light' },
  { width: 1280, height: 800, zoom: 1, colorScheme: 'light' },
  { width: 1280, height: 800, zoom: 2, colorScheme: 'light' },
];
export const ALL_KEYS = ['375x812@100', '768x1024@100', '1280x800@100', '1280x800@200'];

export function audit(browsers: BrowserManager, url: string): Promise<Report> {
  return runAudit(browsers, {
    url,
    configs: ACCEPTANCE_CONFIGS,
    actions: [],
    allowDestructiveActions: false,
    waitUntil: 'load',
    settleMs: 100,
    timeoutMs: 30_000,
    ignoreSelectors: [],
    maxVerifyPerConfig: 40,
    artifactsRoot: ARTIFACTS,
    policy: policyFromEnv({}),
  });
}

/** Selector equals `s` or is a descendant path of it (`s > …`). */
export const selectorIn = (sel: string, s: string): boolean => sel === s || sel.startsWith(`${s} `);

export function involves(f: Finding, selectors: string[]): boolean {
  return selectors.every((s) => f.elements.some((e) => selectorIn(e.selector, s)));
}

export function oneLine(f: Finding): string {
  return `${f.id} ${f.status}/${f.severity} ${f.category} [${f.elements.map((e) => `${e.role}:${e.selector}`).join(', ')}] @ ${f.occurrences.map((o) => o.configKey).join(',')}`;
}
