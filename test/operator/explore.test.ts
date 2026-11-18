import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { explore, type ExploreReport } from '../../src/explore/explorer.js';
import { OPERATOR_ARTIFACTS, operatorEnv, type OperatorEnv } from '../helpers/operator-env.js';

/** Application exploration: safe state-graph discovery with full disclosure of what was not tested. */
describe('exploration: safe state-graph discovery', () => {
  let env: OperatorEnv;
  let admin: ExploreReport;
  let viewer: ExploreReport;

  beforeAll(async () => {
    env = await operatorEnv('explore');
    admin = await explore(env.deps, { url: env.app.url('/projects'), role: 'admin', maxStates: 40, maxActions: 140, maxDepth: 3, maxMinutes: 6 });
    viewer = await explore(env.deps, { url: env.app.url('/projects'), role: 'viewer', maxStates: 40, maxActions: 140, maxDepth: 3, maxMinutes: 6 });
    writeFileSync(join(OPERATOR_ARTIFACTS, 'explore', 'admin-report.json'), JSON.stringify(admin, null, 2));
    writeFileSync(join(OPERATOR_ARTIFACTS, 'explore', 'viewer-report.json'), JSON.stringify(viewer, null, 2));
  }, 900_000);

  afterAll(async () => {
    await env?.close();
  });

  const routes = (r: ExploreReport): string[] => [...new Set(r.states.map((s) => new URL(s.url).pathname))];

  it('never wrote anything to the server (apart from the roles signing in)', () => {
    const s = env.app.stats();
    const { 'POST /api/login': logins, ...writes } = s.writes;
    expect(logins).toBe(2); // session setup for the two roles, before exploration
    expect(writes).toEqual({}); // would include POST /api/refresh-stats had the guard not blocked it
    expect(s.projects).toBe(3);
    expect(s.refreshes).toBe(0);
  });

  it('discovered pages, nested menus, tabs and dynamic-form states', () => {
    const r = routes(admin);
    for (const p of ['/projects', '/dashboard', '/reports', '/checkout', '/orders', '/admin', '/projects/new', '/settings/account', '/settings/team/members']) {
      expect(r, `missing ${p}; got ${r.join(', ')}`).toContain(p);
    }
    expect(admin.states.some((s) => s.overlays.some((o) => /menu:\s*Settings/i.test(o)))).toBe(true);
    expect(admin.states.some((s) => s.overlays.some((o) => /menu:\s*Team/i.test(o)))).toBe(true);
    expect(admin.actions.some((a) => /Fill form/.test(a.description) && a.status === 'tested')).toBe(true);
    expect(admin.edges.length).toBeGreaterThan(10);
  });

  it('accounts for every discovered action: tested or untested with a reason', () => {
    const c = admin.coverage;
    expect(Object.values(c.byStatus).reduce((a, b) => a + b, 0)).toBe(c.actionsDiscovered);
    expect(c.actionsTested).toBeGreaterThan(15);
    for (const a of admin.actions.filter((x) => x.status !== 'tested')) expect(a.reason.length, a.description).toBeGreaterThan(5);
    const unsafe = admin.actions.filter((a) => a.status === 'skipped-unsafe').map((a) => a.description).join(' | ');
    expect(unsafe).toMatch(/Sign out/);
    expect(unsafe).toMatch(/Create project/);
    expect(unsafe).toMatch(/Delete project/);
    expect(admin.disclosures.join(' ')).toMatch(/Untested actions/);
  });

  it('reports a write hidden behind a read-looking control and the CAPTCHA page', () => {
    expect(admin.issues.some((i) => i.kind === 'guard-blocked-write' && /refresh-stats/.test(i.detail))).toBe(true);
    expect(admin.states.some((s) => s.challenge?.kind === 'captcha')).toBe(true);
    expect(admin.disclosures.join(' ')).toMatch(/captcha challenge/);
    expect(admin.issues.some((i) => i.kind === 'blocked' && /cookie-layer/.test(i.detail))).toBe(true);
  });

  it('is role-aware: the viewer reaches fewer states and no admin pages', () => {
    expect(routes(viewer)).not.toContain('/projects/new');
    expect(viewer.states.some((s) => s.headings.includes('Administration'))).toBe(false);
    expect(admin.states.some((s) => s.headings.includes('Administration'))).toBe(true);
    expect(viewer.states.length).toBeLessThan(admin.states.length);
  });

  it('preserves evidence: trace, event log and per-state screenshots', () => {
    expect(admin.evidence.trace && existsSync(admin.evidence.trace)).toBe(true);
    expect(admin.evidence.eventLog && existsSync(admin.evidence.eventLog)).toBe(true);
    expect(admin.states.filter((s) => s.screenshot && existsSync(s.screenshot)).length).toBeGreaterThan(5);
  });

  it('runs UI-quality analysis on discovered states when asked', async () => {
    const r = await explore(env.deps, { url: env.app.url('/broken-ui'), role: 'admin', maxStates: 2, maxActions: 3, auditUi: true });
    const start = r.states[0]!;
    expect(start.ui?.findings.some((f) => f.category === 'obstructed-target')).toBe(true);
    expect(r.issues.some((i) => i.kind === 'ui-finding')).toBe(true);
  });
});
