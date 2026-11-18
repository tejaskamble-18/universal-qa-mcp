import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BrowserManager } from '../../src/browser/session.js';
import { openOperator, type OperatorDeps, type OpenRequest } from '../../src/operator/open.js';
import type { Operator } from '../../src/operator/operator.js';
import { SessionStore, type RoleConfig } from '../../src/operator/sessions.js';
import { policyFromEnv } from '../../src/safety/policy.js';
import { startSampleApp, type SampleApp } from '../sample-app/server.js';

export const OPERATOR_ARTIFACTS = resolve(import.meta.dirname, '..', '..', '.qa-artifacts', 'operator');
export const UPLOAD_DIR = resolve(import.meta.dirname, '..', 'sample-app', 'uploads');

// Credentials reach the operator only through ${env:...} references.
process.env.SAMPLE_ADMIN_PASSWORD = 'admin-pass-1';
process.env.SAMPLE_VIEWER_PASSWORD = 'viewer-pass-1';
export const SECRETS = ['admin-pass-1', 'viewer-pass-1'];

export function roleConfig(app: SampleApp, name: 'admin' | 'viewer'): RoleConfig {
  return {
    name,
    loginUrl: app.url('/login'),
    steps: [
      { type: 'fill', target: { label: 'Username' }, value: name },
      { type: 'fill', target: { label: 'Password' }, value: `\${env:SAMPLE_${name.toUpperCase()}_PASSWORD}` },
      { type: 'click', target: { role: 'button', name: 'Sign in' } },
    ],
    success: [
      { type: 'url', matches: '/dashboard$' },
      { type: 'visible', target: { role: 'button', name: 'Sign out' } },
    ],
    loginUrlPattern: '/login',
  };
}

export interface OperatorEnv {
  app: SampleApp;
  deps: OperatorDeps;
  open: (req: Partial<OpenRequest> & { path: string }) => Promise<Operator>;
  close: () => Promise<void>;
}

export async function operatorEnv(suite: string): Promise<OperatorEnv> {
  const app = await startSampleApp();
  const browsers = new BrowserManager();
  const root = join(OPERATOR_ARTIFACTS, suite);
  rmSync(join(root, 'sessions'), { recursive: true, force: true });
  const policy = policyFromEnv({});
  const sessions = new SessionStore(join(root, 'sessions'), browsers, policy);
  sessions.register(roleConfig(app, 'admin'));
  sessions.register(roleConfig(app, 'viewer'));
  const deps: OperatorDeps = {
    browsers,
    policy,
    sessions,
    artifactsRoot: root,
    writeOrigins: [],
    uploadRoots: [UPLOAD_DIR],
    defaults: { actionTimeoutMs: 2500, expectTimeoutMs: 3000 },
  };
  let n = 0;
  return {
    app,
    deps,
    open: async (req) => {
      const { op, reason } = await openOperator(deps, {
        mode: 'safe',
        label: `${suite}-${++n}`,
        ...req,
        url: app.url(req.path),
      });
      if (!op) throw new Error(`could not open: ${reason}`);
      return op;
    },
    close: async () => {
      await browsers.close();
      await app.close();
    },
  };
}

/** Every text file under `dir` (recursively), for secret-leak checks. */
export function textFiles(dir: string): { path: string; text: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return textFiles(p);
    return /\.(json|jsonl|md|txt|csv)$/.test(n) ? [{ path: p, text: readFileSync(p, 'utf8') }] : [];
  });
}

/** Assert an action status, printing the reason and expectation results when it differs. */
export function status(r: { status: string; reason: string; description: string; expectations: { description: string; passed: boolean; actual: string }[]; attempts?: unknown[] }): string {
  if (r.status === 'passed') return r.status;
  const exp = r.expectations.map((e) => `  ${e.passed ? '✓' : '✗'} ${e.description} — actual: ${e.actual}`).join('\n');
  // Returned value is compared by the caller; the detail goes to stderr for diagnosis.
  process.stderr.write(`[action] ${r.description} → ${r.status}: ${r.reason}\n${exp}\n`);
  return r.status;
}
