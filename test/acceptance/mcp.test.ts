import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Report } from '../../src/report/schema.js';
import { ARTIFACTS } from '../helpers/audit.js';
import { startFixtureServer } from '../helpers/fixture-server.js';
import { startSampleApp } from '../sample-app/server.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

type ToolResult = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; structuredContent?: unknown; isError?: boolean };

async function connect(era: 'legacy' | 'modern', extraEnv: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist', 'index.js')],
    env: { ...getDefaultEnvironment(), QA_MCP_ARTIFACTS_DIR: join(ARTIFACTS, 'mcp'), ...extraEnv },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'uqa-acceptance', version: '1.0.0' });
  await client.connect(transport, era === 'legacy' ? { prior: { kind: 'legacy' } } : undefined);
  return client;
}

/** End-to-end over real stdio, the way Claude Code launches the server. */
describe('MCP server over stdio', () => {
  let server: Awaited<ReturnType<typeof startFixtureServer>>;

  beforeAll(async () => {
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe' });
    server = await startFixtureServer();
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  it('serves the legacy (2025) initialize handshake: list, audit, evidence, inspect, policy refusal', async () => {
    const client = await connect('legacy');
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).filter((n) => n.startsWith('qa_')).sort();
      expect(names).toEqual(['qa_audit_layout', 'qa_get_evidence', 'qa_inspect_element', 'qa_list_checks']);
      expect(tools.tools.find((t) => t.name === 'qa_audit_layout')!.outputSchema).toBeDefined();

      const res = (await client.callTool({
        name: 'qa_audit_layout',
        arguments: { url: server.url('broken/toolbar.html'), viewports: [{ width: 1280, height: 800 }], includeImages: 1 },
      })) as ToolResult;
      expect(res.isError).toBeFalsy();
      const report = res.structuredContent as Report;
      const overlap = report.findings.find((f) => f.category === 'overlap' && f.elements.some((e) => e.selector === '#btn-save'));
      expect(overlap?.status).toBe('verified');
      expect(res.content[0]!.text).toContain(overlap!.id);
      expect(res.content.some((c) => c.type === 'image' && c.mimeType === 'image/png' && (c.data?.length ?? 0) > 100)).toBe(true);

      const ev = (await client.callTool({ name: 'qa_get_evidence', arguments: { runId: report.runId, findingId: overlap!.id } })) as ToolResult;
      expect(ev.isError).toBeFalsy();
      expect(ev.content.some((c) => c.type === 'image')).toBe(true);

      const inspect = (await client.callTool({
        name: 'qa_inspect_element',
        arguments: { url: server.url('broken/hidden-controls.html'), selector: '#btn-pay', viewport: { width: 1280, height: 800 } },
      })) as ToolResult;
      expect(inspect.isError).toBeFalsy();
      const info = JSON.parse(inspect.content[0]!.text!);
      expect(info.found).toBe(true);
      const tops = info.hitProbes.flatMap((p: { samples: { top: string }[] }) => p.samples.map((s) => s.top));
      expect(tops).toContain('#click-shield');

      const refused = (await client.callTool({ name: 'qa_audit_layout', arguments: { url: 'https://example.com/' } })) as ToolResult;
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toMatch(/not authorised/);
    } finally {
      await client.close();
    }
  });

  it('drives the browser operator tools: login, open, act, observe, close, workflow, explore', async () => {
    const app = await startSampleApp();
    const client = await connect('legacy', {
      QA_MCP_SESSIONS_DIR: join(ARTIFACTS, 'mcp-sessions'),
      SAMPLE_ADMIN_PASSWORD: 'admin-pass-1',
    });
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
    const json = (r: ToolResult) => JSON.parse(r.content[0]!.text!);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of ['ui_login', 'ui_open', 'ui_observe', 'ui_act', 'ui_close', 'ui_run_workflow', 'ui_explore']) expect(names).toContain(n);

      const role = {
        name: 'admin',
        loginUrl: app.url('/login'),
        success: [{ type: 'url', matches: '/dashboard$' }],
        loginUrlPattern: '/login',
      };
      const leaky = await call('ui_login', { ...role, steps: [{ type: 'fill', target: { label: 'Password' }, value: 'admin-pass-1' }] });
      expect(leaky.isError).toBe(true);
      expect(leaky.content[0]!.text).toMatch(/env:VAR/);

      const login = await call('ui_login', {
        ...role,
        steps: [
          { type: 'fill', target: { label: 'Username' }, value: 'admin' },
          { type: 'fill', target: { label: 'Password' }, value: '${env:SAMPLE_ADMIN_PASSWORD}' },
          { type: 'click', target: { role: 'button', name: 'Sign in' } },
        ],
      });
      expect(login.isError, login.content[0]!.text).toBeFalsy();
      expect(json(login).status).toBe('logged-in');

      const opened = json(await call('ui_open', { url: app.url('/projects'), role: 'admin' }));
      expect(opened.open.status).toBe('passed');
      const settings = opened.observation.controls.find((c: { name: string }) => c.name === 'Settings');
      const act = json(await call('ui_act', { sessionId: opened.sessionId, action: { type: 'click', target: { controlId: settings.ref } } }));
      expect(act.result.status).toBe('passed');
      const obs = json(await call('ui_observe', { sessionId: opened.sessionId }));
      expect(obs.overlays.join(' ')).toMatch(/menu/);
      const refused = json(await call('ui_act', { sessionId: opened.sessionId, action: { type: 'navigate', url: app.url('/projects/new') } }));
      expect(refused.result.status).toBe('passed');
      const write = json(await call('ui_act', { sessionId: opened.sessionId, action: { type: 'click', target: { role: 'button', name: 'Create project' } }, write: true }));
      expect(write.result.status).toBe('refused');
      const closed = json(await call('ui_close', { sessionId: opened.sessionId }));
      expect(closed.byStatus.refused).toBe(1);
      expect(closed.evidence.trace).toMatch(/trace\.zip$/);

      const wf = json(await call('ui_run_workflow', {
        workflow: {
          name: 'mcp workflow',
          role: 'admin',
          startUrl: app.url('/projects'),
          steps: [{ action: { type: 'click', target: { role: 'link', name: 'Project Alpha' } }, expect: [{ type: 'text', contains: 'Overview' }] }],
        },
      }));
      expect(wf.status).toBe('passed');

      const ex = json(await call('ui_explore', { url: app.url('/projects'), role: 'admin', maxActions: 6, maxStates: 4 }));
      expect(ex.coverage.actionsTested).toBeGreaterThan(0);
      expect(ex.disclosures.join(' ')).toMatch(/read-only/);
      expect(app.stats().projects).toBe(3);
    } finally {
      await client.close();
      await app.close();
    }
  }, 300_000);

  it('serves the modern protocol era as well', async () => {
    const client = await connect('modern');
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('qa_audit_layout');
      const checks = (await client.callTool({ name: 'qa_list_checks', arguments: {} })) as ToolResult;
      const info = JSON.parse(checks.content[1]!.text!);
      expect(info.checks.map((c: { category: string }) => c.category)).toContain('popup-clipping');
    } finally {
      await client.close();
    }
  });
});
