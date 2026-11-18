import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openOperator } from '../../src/operator/open.js';
import type { Operator } from '../../src/operator/operator.js';
import { operatorEnv, status, type OperatorEnv } from '../helpers/operator-env.js';

const APPROVAL = { approvedBy: 'acceptance-test', reason: 'controlled sample app' };

/**
 * Write safety, duplicate prevention, bounded retries, network failures,
 * session expiry and recovery — checked against what the server really received.
 */
describe('operator: safety, failures and recovery', () => {
  let env: OperatorEnv;

  beforeAll(async () => {
    env = await operatorEnv('safety');
  }, 120_000);

  beforeEach(() => env.app.reset());

  afterAll(async () => {
    await env?.close();
  });

  const approved = (path: string, role: 'admin' | 'viewer' = 'admin'): Promise<Operator> =>
    env.open({ path, role, mode: 'approved-writes', approval: APPROVAL });

  it('safe mode refuses writes before they run, declared or not', async () => {
    const op = await env.open({ path: '/projects/new', role: 'admin' });
    try {
      await op.act({ type: 'fill', target: { label: 'Project name' }, value: 'Safe' });
      expect(status(await op.act({ type: 'click', target: { role: 'button', name: 'Create project' } }))).toBe('refused');
      expect(status(await op.act({ type: 'click', target: { role: 'button', name: 'Create project' } }, { write: true }))).toBe('refused');
      expect(env.app.stats().writes['POST /api/projects']).toBeUndefined();
    } finally {
      await op.close();
    }
  });

  it('the network guard stops a write hidden behind a read-looking control', async () => {
    const op = await env.open({ path: '/dashboard', role: 'admin' });
    try {
      const r = await op.act({ type: 'click', target: { role: 'button', name: 'Refresh stats' } }, { expect: [{ type: 'text', contains: 'Stats refreshed' }] });
      expect(r.kind).toBe('read');
      expect(status(r)).toBe('failed');
      expect(r.effects!.requests.some((q) => q.method === 'POST' && q.blockedByGuard === 'safe-mode')).toBe(true);
      expect(env.app.stats().refreshes).toBe(0);
    } finally {
      await op.close();
    }
  });

  it('performs an approved write once, verifies it, and prevents an accidental repeat', async () => {
    const op = await approved('/projects/new');
    try {
      await op.act({ type: 'fill', target: { label: 'Project name' }, value: 'Operator Project' });
      await op.act({ type: 'select', target: { label: 'Project type' }, value: 'internal' });
      const create = await op.act({ type: 'click', target: { role: 'button', name: 'Create project' } }, {
        write: true,
        expect: [
          { type: 'url', matches: '/projects/\\d+$' },
          { type: 'alert', contains: 'Project created' },
          { type: 'request', method: 'POST', url: '/api/projects$', status: 201, count: 1 },
        ],
      });
      expect(status(create)).toBe('passed');
      await op.act({ type: 'navigate', url: '/projects/new' });
      await op.act({ type: 'fill', target: { label: 'Project name' }, value: 'Operator Project' });
      await op.act({ type: 'select', target: { label: 'Project type' }, value: 'internal' });
      const again = await op.act({ type: 'click', target: { role: 'button', name: 'Create project' } }, { write: true });
      expect(status(again)).toBe('duplicate-prevented');
      expect(env.app.stats().projects).toBe(4);
      expect(env.app.stats().writes['POST /api/projects']).toBe(1);
    } finally {
      await op.close();
    }
  });

  it('verifies client-side validation without sending anything', async () => {
    const op = await approved('/projects/new');
    try {
      await op.act({ type: 'select', target: { label: 'Project type' }, value: 'client' });
      await op.act({ type: 'fill', target: { label: 'Billing email' }, value: 'not-an-email' });
      const r = await op.act({ type: 'click', target: { role: 'button', name: 'Create project' } }, {
        write: true,
        expect: [
          { type: 'alert', contains: 'Client name is required' },
          { type: 'alert', contains: 'Enter a valid billing email' },
          { type: 'noRequest', method: 'POST', url: '/api/projects' },
        ],
      });
      expect(status(r)).toBe('passed');
      expect(r.effects!.writeRequests).toBe(0);
    } finally {
      await op.close();
    }
  });

  it('does not retry a write whose response was lost, and a read then confirms the outcome', async () => {
    env.app.fail({ method: 'POST', path: '^/api/orders$', times: 1, mode: 'process-then-502' });
    const op = await approved('/checkout');
    try {
      expect(status(await op.act({ type: 'click', target: { role: 'radio', name: 'Team' } }))).toBe('passed');
      await op.act({ type: 'click', target: { role: 'button', name: 'Next' } });
      await op.act({ type: 'fill', target: { label: 'Company name' }, value: 'Initech' });
      await op.act({ type: 'fill', target: { label: 'Seats' }, value: '5' });
      await op.act({ type: 'click', target: { role: 'button', name: 'Next' } });
      const place = await op.act({ type: 'click', target: { role: 'button', name: 'Place order' } }, { write: true, expect: [{ type: 'text', contains: 'Order confirmed' }] });
      expect(status(place)).toBe('outcome-unknown');
      expect(place.attempts).toHaveLength(1);
      expect(env.app.stats().writes['POST /api/orders']).toBe(1);
      expect(env.app.stats().orders).toBe(1);
      const check = await op.act({ type: 'navigate', url: '/orders' }, { expect: [{ type: 'text', contains: 'ORD-1001' }] });
      expect(status(check)).toBe('passed');
      expect(op.writeLedger().some((w) => w.status === 'unknown')).toBe(true);
    } finally {
      await op.close();
    }
  });

  it('retries a failed read within bounds, and stops at the bound', async () => {
    env.app.fail({ method: 'GET', path: '^/api/reports$', times: 2, mode: 'status-500' });
    let op = await env.open({ path: '/reports', role: 'admin' }); // first load consumes one failure
    try {
      const r = await op.act({ type: 'click', target: { role: 'button', name: 'Reload data' } }, { expect: [{ type: 'text', contains: 'Report 1' }] });
      expect(status(r)).toBe('passed');
      expect(r.attempts).toHaveLength(2);
    } finally {
      await op.close();
    }
    env.app.fail({ method: 'GET', path: '^/api/reports$', times: 50, mode: 'status-500' });
    op = await env.open({ path: '/reports', role: 'admin' });
    try {
      const r = await op.act({ type: 'click', target: { role: 'button', name: 'Reload data' } }, { expect: [{ type: 'text', contains: 'Report 1' }], expectTimeoutMs: 1000 });
      expect(status(r)).toBe('failed');
      expect(r.attempts).toHaveLength(3);
    } finally {
      await op.close();
    }
  });

  it('a 500 on a write is not retried (outcome unconfirmed) and nothing is duplicated', async () => {
    env.app.fail({ method: 'POST', path: '^/api/projects$', times: 1, mode: 'status-500' });
    const op = await approved('/projects/new');
    try {
      await op.act({ type: 'fill', target: { label: 'Project name' }, value: 'Flaky' });
      await op.act({ type: 'select', target: { label: 'Project type' }, value: 'internal' });
      const r = await op.act({ type: 'click', target: { role: 'button', name: 'Create project' } }, { write: true, expect: [{ type: 'url', matches: '/projects/\\d+$' }] });
      expect(status(r)).toBe('outcome-unknown');
      expect(env.app.stats().writes['POST /api/projects']).toBe(1);
    } finally {
      await op.close();
    }
  });

  it('follows the declared dialog policy for a destructive confirm', async () => {
    const op = await approved('/projects/2');
    try {
      const dismissed = await op.act({ type: 'click', target: { role: 'button', name: 'Delete project' } }, {
        write: true,
        dialog: { accept: false },
        expect: [{ type: 'dialog', kind: 'confirm', messageContains: 'Delete Project Beta' }, { type: 'noRequest', method: 'DELETE', url: '/api/projects/' }],
      });
      expect(status(dismissed)).toBe('passed');
      const accepted = await op.act({ type: 'click', target: { role: 'button', name: 'Delete project' } }, {
        write: true,
        dialog: { accept: true },
        expect: [{ type: 'request', method: 'DELETE', url: '/api/projects/2$', status: 200, count: 1 }, { type: 'url', matches: '/projects$' }],
      });
      expect(status(accepted)).toBe('passed');
      expect(env.app.stats().projects).toBe(2);
    } finally {
      await op.close();
    }
    const viewer = await approved('/projects/1', 'viewer');
    try {
      expect(status(await viewer.act({ type: 'click', target: { role: 'button', name: 'Delete project' } }, { write: true }))).toBe('blocked');
    } finally {
      await viewer.close();
    }
  });

  it('expired session: scripted re-authentication resumes a read; operator mode stops and asks', async () => {
    const { op } = await openOperator(env.deps, { url: env.app.url('/projects'), role: 'admin', mode: 'safe', reauth: 'scripted', label: 'safety-reauth' });
    try {
      const logins = env.app.stats().logins;
      env.app.expireSessions();
      const r = await op!.act({ type: 'click', target: { role: 'link', name: 'Reports', exact: true } }, { expect: [{ type: 'text', contains: 'Report 1' }] });
      expect(status(r)).toBe('passed');
      expect(r.notes.join(' ')).toMatch(/re-authenticated/);
      expect(env.app.stats().logins).toBe(logins + 1);
    } finally {
      await op!.close();
    }
    const { op: v } = await openOperator(env.deps, { url: env.app.url('/projects'), role: 'viewer', mode: 'safe', reauth: 'operator', label: 'safety-expired' });
    try {
      env.app.expireSessions();
      const r = await v!.act({ type: 'click', target: { role: 'link', name: 'Reports', exact: true } });
      expect(status(r)).toBe('needs-operator');
      expect(r.challenge?.kind).toBe('session-expired');
      const next = await v!.act({ type: 'click', target: { role: 'link', name: 'Orders', exact: true } });
      expect(status(next)).toBe('needs-operator');
      expect(next.attempts).toHaveLength(0);
    } finally {
      await v!.close();
    }
  });

  it('refuses literal secrets in login scripts', () => {
    expect(() =>
      env.deps.sessions.register({
        name: 'leaky',
        loginUrl: env.app.url('/login'),
        steps: [{ type: 'fill', target: { label: 'Password' }, value: 'hunter2' }],
        success: [{ type: 'url', matches: '/dashboard' }],
      }),
    ).toThrow(/env:VAR/);
  });
});
