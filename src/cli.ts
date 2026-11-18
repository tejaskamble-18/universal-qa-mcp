#!/usr/bin/env node
/**
 * Local CLI over the same engine the MCP server uses.
 *   node dist/cli.js <url> [--viewports 375x812,1280x800] [--zoom 1,2] [--out DIR] [--json]
 */
import { resolve } from 'node:path';
import { BrowserManager, type ConfigRequest } from './browser/session.js';
import { DEFAULT_CONFIGS, runAudit } from './engine/audit.js';
import { formatSummary } from './report/format.js';
import { checkUrl, policyFromEnv } from './safety/policy.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url || url.startsWith('--')) {
    console.error('usage: universal-qa-audit <url> [--viewports 375x812,1280x800] [--zoom 1,2] [--out DIR] [--json]');
    process.exit(2);
  }
  const policy = policyFromEnv();
  const pol = checkUrl(url, policy);
  if (!pol.ok) {
    console.error(pol.reason);
    process.exit(2);
  }
  const viewports = arg('viewports')
    ? arg('viewports')!.split(',').map((v) => {
        const [w, h] = v.split('x').map(Number);
        return { width: w!, height: h! };
      })
    : DEFAULT_CONFIGS.map((c) => ({ width: c.width, height: c.height }));
  const zooms = arg('zoom') ? arg('zoom')!.split(',').map(Number) : [1];
  const configs: ConfigRequest[] = viewports.flatMap((v) => zooms.map((zoom) => ({ ...v, zoom, colorScheme: 'light' as const })));
  const browsers = new BrowserManager();
  try {
    const report = await runAudit(browsers, {
      url: pol.url.href,
      configs,
      actions: [],
      allowDestructiveActions: false,
      waitUntil: 'load',
      settleMs: 300,
      timeoutMs: 30_000,
      ignoreSelectors: [],
      maxVerifyPerConfig: 40,
      artifactsRoot: resolve(arg('out') ?? '.qa-artifacts'),
      policy,
      log: (m) => console.error(m),
    });
    console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatSummary(report, 200));
  } finally {
    await browsers.close();
  }
}

void main();
