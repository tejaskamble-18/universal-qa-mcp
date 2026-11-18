import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR_ARTIFACTS, operatorEnv, SECRETS, status, textFiles, UPLOAD_DIR, type OperatorEnv } from '../helpers/operator-env.js';

/**
 * Browser control against the controlled sample app: every interaction type,
 * verification of outcomes, and honest statuses for blocked / unverified /
 * challenged actions.
 */
describe('operator: interaction and verification', () => {
  let env: OperatorEnv;

  beforeAll(async () => {
    env = await operatorEnv('interaction');
  }, 120_000);

  afterAll(async () => {
    await env?.close();
  });

  it('logs each role into its own isolated session', async () => {
    expect((await env.deps.sessions.loginScripted('admin')).status).toBe('logged-in');
    expect((await env.deps.sessions.loginScripted('viewer')).status).toBe('logged-in');
    const a = await env.open({ path: '/admin', role: 'admin' });
    const v = await env.open({ path: '/admin', role: 'viewer' });
    try {
      expect(a.results[0]!.status).toBe('passed');
      expect((await a.act({ type: 'wait', ms: 0 }, { expect: [{ type: 'text', contains: 'Administration' }, { type: 'visible', target: { role: 'link', name: 'Admin', exact: true } }] })).status).toBe('passed');
      expect((await v.act({ type: 'wait', ms: 0 }, { expect: [{ type: 'text', contains: 'Not authorized' }, { type: 'hidden', target: { role: 'link', name: 'Admin', exact: true } }] })).status).toBe('passed');
      const [ca] = await a.context.cookies();
      const [cv] = await v.context.cookies();
      expect(ca!.value).not.toBe(cv!.value);
    } finally {
      await a.close();
      await v.close();
    }
  });

  it('verifies a dynamic form: conditional fields appear and intrinsic value checks pass', async () => {
    const op = await env.open({ path: '/projects/new', role: 'admin' });
    try {
      const fill = await op.act({ type: 'fill', target: { label: 'Project name' }, value: 'Dynamic' });
      expect(status(fill)).toBe('passed');
      expect(fill.expectations[0]).toMatchObject({ source: 'intrinsic', passed: true });
      const sel = await op.act({ type: 'select', target: { label: 'Project type' }, value: 'client' }, { expect: [{ type: 'visible', target: { label: 'Billing email' } }] });
      expect(status(sel)).toBe('passed');
      const check = await op.act({ type: 'check', target: { label: 'Has deadline' } }, { expect: [{ type: 'visible', target: { label: 'Deadline' } }] });
      expect(status(check)).toBe('passed');
      const submit = await op.act({ type: 'click', target: { role: 'button', name: 'Create project' } });
      expect(status(submit)).toBe('refused');
      expect(submit.kind).toBe('write');
      expect(env.app.stats().projects).toBe(3);
    } finally {
      await op.close();
    }
  });

  it('opens nested menus level by level and lands on the submenu page', async () => {
    const op = await env.open({ path: '/dashboard', role: 'admin' });
    try {
      const settings = await op.act({ type: 'click', target: { role: 'button', name: 'Settings' } });
      expect(status(settings)).toBe('passed');
      expect(settings.effects!.overlaysOpened.join()).toMatch(/menu/);
      const team = await op.act({ type: 'click', target: { role: 'menuitem', name: 'Team' } });
      expect(status(team)).toBe('passed');
      const members = await op.act({ type: 'click', target: { role: 'menuitem', name: 'Members' } }, { expect: [{ type: 'text', contains: 'Team members' }] });
      expect(status(members)).toBe('passed');
      expect(members.effects!.urlAfter).toMatch(/\/settings\/team\/members$/);
    } finally {
      await op.close();
    }
  });

  it('operates tabs with the keyboard and waits for delayed content', async () => {
    const op = await env.open({ path: '/projects/1', role: 'admin' });
    try {
      expect((await op.act({ type: 'focus', target: { role: 'tab', name: 'Overview' } })).status).not.toBe('blocked');
      const key = await op.act({ type: 'press', key: 'ArrowRight', target: { role: 'tab', name: 'Overview' } }, { expect: [{ type: 'state', target: { role: 'tab', name: 'Files' }, selected: true }] });
      expect(status(key)).toBe('passed');
      const activity = await op.act({ type: 'click', target: { role: 'tab', name: 'Activity' } }, { expect: [{ type: 'text', contains: 'Ada exported the weekly report' }] });
      expect(status(activity)).toBe('passed');
      const missing = await op.act({ type: 'wait', ms: 0 }, { expect: [{ type: 'text', contains: 'An entry that never appears' }], expectTimeoutMs: 400 });
      expect(status(missing)).toBe('failed');
      expect(missing.expectations[0]!.actual).toMatch(/not in/);
    } finally {
      await op.close();
    }
  });

  it('uploads only from allowed directories and reorders with drag and drop', async () => {
    const op = await env.open({ path: '/projects/1', role: 'admin' });
    try {
      await op.act({ type: 'click', target: { role: 'tab', name: 'Files' } });
      const up = await op.act({ type: 'upload', target: { label: 'Attach files' }, files: [join(UPLOAD_DIR, 'report.txt')] }, { expect: [{ type: 'text', contains: 'report.txt (' }] });
      expect(status(up)).toBe('passed');
      expect(up.expectations.some((e) => e.source === 'intrinsic' && /report\.txt/.test(e.actual))).toBe(true);
      const outside = await op.act({ type: 'upload', target: { label: 'Attach files' }, files: [resolve(import.meta.dirname, '..', '..', 'package.json')] });
      expect(status(outside)).toBe('refused');
      const drag = await op.act(
        { type: 'drag', source: { selector: '#task-list li[data-task="Ship"]' }, target: { selector: '#task-list li[data-task="Design"]' } },
        { expect: [{ type: 'text', within: '#task-list', contains: 'Ship\nDesign' }] },
      );
      expect(status(drag)).toBe('passed');
    } finally {
      await op.close();
    }
  });

  it('verifies popups, tab switching, downloads and infinite scroll', async () => {
    const op = await env.open({ path: '/reports', role: 'admin' });
    try {
      const popup = await op.act({ type: 'click', target: { role: 'button', name: 'Open preview' } }, { expect: [{ type: 'popup', urlMatches: '/reports/preview' }] });
      expect(status(popup)).toBe('passed');
      const sw = await op.act({ type: 'switchTab', urlMatches: 'preview' }, { expect: [{ type: 'text', contains: 'Report preview' }] });
      expect(status(sw)).toBe('passed');
      expect((await op.act({ type: 'closeTab' })).status).not.toBe('blocked');
      const dl = await op.act({ type: 'click', target: { role: 'link', name: 'Export CSV' } });
      expect(status(dl)).toBe('passed');
      expect(dl.effects!.downloads[0]!.filename).toBe('projects.csv');
      const before = await op.act({ type: 'wait', ms: 0 }, { expect: [{ type: 'count', target: { selector: '#reports li' }, equals: 15 }] });
      expect(status(before)).toBe('passed');
      const scroll = await op.act({ type: 'scroll', direction: 'down', amount: 5000 }, { expect: [{ type: 'text', contains: 'Report 16' }] });
      expect(status(scroll)).toBe('passed');
    } finally {
      await op.close();
    }
  });

  it('reports a click swallowed by an invisible layer as blocked and names the interceptor', async () => {
    const op = await env.open({ path: '/broken-ui', role: 'admin' });
    try {
      const r = await op.act({ type: 'click', target: { role: 'button', name: 'Preview changes' } }, { retries: 1, expect: [{ type: 'text', contains: 'Preview ready' }] });
      expect(status(r)).toBe('blocked');
      expect(r.interceptedBy).toMatch(/cookie-layer/);
      expect(r.attempts).toHaveLength(2);
      expect(r.attempts.every((a) => a.error?.kind === 'intercepted')).toBe(true);
      // After dismissing the banner the same click works and is verified.
      expect((await op.act({ type: 'click', target: { role: 'button', name: 'Dismiss' } })).status).toBe('performed');
      expect((await op.act({ type: 'click', target: { role: 'button', name: 'Preview changes' } }, { expect: [{ type: 'text', contains: 'Preview ready' }] })).status).toBe('passed');
    } finally {
      await op.close();
    }
  });

  it('never reports an action without a checked outcome as success', async () => {
    const op = await env.open({ path: '/broken-ui', role: 'admin' });
    try {
      const dismiss = await op.act({ type: 'click', target: { role: 'button', name: 'Dismiss' } });
      expect(status(dismiss)).toBe('performed');
      const dead = await op.act({ type: 'click', target: { role: 'button', name: 'Show tips' } });
      expect(status(dead)).toBe('no-effect');
      const ambiguous = await op.act({ type: 'click', target: { selector: '.card' } });
      expect(status(ambiguous)).toBe('blocked');
      expect(ambiguous.reason).toMatch(/ambiguous/);
    } finally {
      await op.close();
    }
  });

  it('stops at a CAPTCHA and never interacts with it', async () => {
    const op = await env.open({ path: '/captcha' });
    try {
      expect(op.results[0]!.status).toBe('needs-operator');
      expect(op.results[0]!.challenge?.kind).toBe('captcha');
      const click = await op.act({ type: 'click', target: { role: 'button', name: 'Continue' } });
      expect(status(click)).toBe('needs-operator');
      expect(click.attempts).toHaveLength(0);
      const frame = await op.act({ type: 'click', target: { frame: 'iframe[src*="recaptcha"]', selector: '#x' } });
      expect(['needs-operator', 'refused']).toContain(frame.status);
    } finally {
      await op.close();
    }
  });

  it('treats a 403 page as blocked access and refuses out-of-scope navigation', async () => {
    const blocked = await env.open({ path: '/blocked' });
    try {
      expect(blocked.results[0]!.status).toBe('needs-operator');
      expect(blocked.results[0]!.challenge?.kind).toBe('blocked');
    } finally {
      await blocked.close();
    }
    const op = await env.open({ path: '/login' });
    try {
      const out = await op.act({ type: 'navigate', url: 'https://example.com/' });
      expect(status(out)).toBe('refused');
    } finally {
      await op.close();
    }
  });

  it('keeps credentials out of every evidence file', () => {
    const leaks = textFiles(join(OPERATOR_ARTIFACTS, 'interaction')).filter((f) => SECRETS.some((s) => f.text.includes(s)));
    expect(leaks.map((f) => f.path)).toEqual([]);
  });
});
