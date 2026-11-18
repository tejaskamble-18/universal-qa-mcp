import { existsSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runWorkflow, type WorkflowDef } from '../../src/functional/workflow.js';
import { operatorEnv, type OperatorEnv } from '../helpers/operator-env.js';

/** Functional verification: multi-step workflows, transitions, disclosures, UI analysis per step. */
describe('workflows: verified multi-step flows', () => {
  let env: OperatorEnv;

  beforeAll(async () => {
    env = await operatorEnv('workflow');
  }, 120_000);

  beforeEach(() => env.app.reset());

  afterAll(async () => {
    await env?.close();
  });

  const dump = (r: Awaited<ReturnType<typeof runWorkflow>>): string =>
    r.steps.map((s) => `${s.index + 1}. ${s.status} ${s.description} — ${s.reason}`).join('\n');

  it('runs a checkout with back/edit transitions and verifies every step', async () => {
    const wf: WorkflowDef = {
      name: 'checkout with edits',
      role: 'admin',
      startUrl: env.app.url('/checkout'),
      writes: { approvedBy: 'acceptance-test', reason: 'controlled sample app' },
      steps: [
        { action: { type: 'click', target: { role: 'radio', name: 'Team' } } },
        { action: { type: 'click', target: { role: 'button', name: 'Next' } }, expect: [{ type: 'visible', target: { label: 'Company name' } }] },
        { action: { type: 'fill', target: { label: 'Company name' }, value: 'Initech' } },
        { action: { type: 'fill', target: { label: 'Seats' }, value: '5' } },
        { id: 'back-keeps-plan', action: { type: 'click', target: { role: 'button', name: 'Back' } }, expect: [{ type: 'state', target: { role: 'radio', name: 'Team' }, checked: true }] },
        { id: 'next-keeps-details', action: { type: 'click', target: { role: 'button', name: 'Next' } }, expect: [{ type: 'state', target: { label: 'Company name' }, value: 'Initech' }] },
        { action: { type: 'click', target: { role: 'button', name: 'Next' } }, expect: [{ type: 'text', contains: 'Review your order' }] },
        { id: 'edit-returns', action: { type: 'click', target: { role: 'button', name: 'Edit details' } }, expect: [{ type: 'state', target: { label: 'Seats' }, value: '5' }] },
        { action: { type: 'fill', target: { label: 'Seats' }, value: '7' } },
        { action: { type: 'click', target: { role: 'button', name: 'Next' } }, expect: [{ type: 'text', within: '#review-seats', contains: '7' }] },
        {
          id: 'place-order',
          action: { type: 'click', target: { role: 'button', name: 'Place order' } },
          write: true,
          expect: [
            { type: 'text', contains: 'Order confirmed' },
            { type: 'request', method: 'POST', url: '/api/orders$', status: 201, count: 1 },
          ],
        },
        { action: { type: 'click', target: { role: 'link', name: 'View orders' } }, expect: [{ type: 'text', contains: 'Initech' }] },
      ],
    };
    const r = await runWorkflow(env.deps, wf);
    expect(r.status, dump(r)).toBe('passed');
    expect(r.steps.every((s) => s.verified)).toBe(true);
    expect(env.app.stats().orders).toBe(1);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]!.status).toBe('succeeded');
    expect(r.evidence.trace && existsSync(r.evidence.trace)).toBe(true);
    expect(r.evidence.eventLog && existsSync(r.evidence.eventLog)).toBe(true);
    expect(r.steps.every((s) => s.result?.evidence.after && existsSync(s.result.evidence.after))).toBe(true);
  });

  it('stops at the first failing step and discloses the rest as not run', async () => {
    const r = await runWorkflow(env.deps, {
      name: 'failing',
      role: 'admin',
      startUrl: env.app.url('/projects'),
      steps: [
        { action: { type: 'click', target: { role: 'link', name: 'Project Alpha' } }, expect: [{ type: 'text', contains: 'Overview' }] },
        { action: { type: 'click', target: { role: 'tab', name: 'Files' } }, expect: [{ type: 'text', contains: 'A heading that does not exist' }], expectTimeoutMs: 500 },
        { action: { type: 'click', target: { role: 'tab', name: 'Activity' } } },
        { action: { type: 'click', target: { role: 'tab', name: 'Overview' } } },
      ],
    });
    expect(r.status).toBe('failed');
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'not-run', 'not-run']);
    expect(r.disclosures.filter((d) => /was not run/.test(d))).toHaveLength(2);
  });

  it('reports a workflow with an unverified step as incomplete, never passed', async () => {
    const r = await runWorkflow(env.deps, {
      name: 'unverified',
      role: 'admin',
      startUrl: env.app.url('/broken-ui'),
      steps: [{ action: { type: 'click', target: { role: 'button', name: 'Dismiss' } } }],
    });
    expect(r.status).toBe('incomplete');
    expect(r.steps[0]!.status).toBe('performed');
    expect(r.disclosures.join(' ')).toMatch(/NOT verified/);
  });

  it('combines functional checks with UI-quality analysis of the same state', async () => {
    const r = await runWorkflow(env.deps, {
      name: 'broken preferences',
      role: 'admin',
      startUrl: env.app.url('/broken-ui'),
      steps: [
        {
          id: 'try-preview',
          action: { type: 'click', target: { role: 'button', name: 'Preview changes' } },
          expect: [{ type: 'text', contains: 'Preview ready' }],
          retries: 0,
          auditUi: true,
          optional: true,
        },
      ],
    });
    const step = r.steps[0]!;
    expect(step.status).toBe('blocked');
    expect(step.result!.interceptedBy).toMatch(/cookie-layer/);
    const cats = step.ui!.findings.map((f) => `${f.category}:${f.elements.join(',')}`);
    expect(cats.some((c) => c.startsWith('obstructed-target:') && c.includes('#cookie-layer'))).toBe(true);
    expect(cats.some((c) => c.startsWith('misalignment:') && c.includes('#card-c'))).toBe(true);
  });

  it('asks for an operator when a role has no session and no scripted login', async () => {
    const r = await runWorkflow(env.deps, {
      name: 'unknown role',
      role: 'auditor',
      startUrl: env.app.url('/dashboard'),
      steps: [{ action: { type: 'click', target: { role: 'link', name: 'Projects' } } }],
    });
    expect(r.status).toBe('needs-operator');
    expect(r.steps[0]!.status).toBe('not-run');
  });
});
