import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { explore, ExploreSchema } from './explore/explorer.js';
import { runWorkflow, WorkflowSchema } from './functional/workflow.js';
import { newRunId, openOperator, type OperatorDeps } from './operator/open.js';
import { PolicyError, type Operator } from './operator/operator.js';
import { RoleSchema } from './operator/sessions.js';
import { ActOptionsSchema, OpActionSchema, type ActionResult, type Observation } from './operator/types.js';

export const OPERATOR_INSTRUCTIONS = `Browser operator (ui_* tools): verified interaction with authorised apps.
Every ui_act result has a status: "passed" only when an expected outcome (explicit "expect" or the control's own
semantics: filled value, checked box, selected tab, expanded menu, link URL) was observed; "performed" means it ran
and something changed but nothing was verified; "no-effect", "failed", "blocked" (intercepted/hidden/disabled/missing),
"refused" (policy), "duplicate-prevented", "outcome-unknown" (write sent, result unconfirmed, NOT retried) and
"needs-operator" (CAPTCHA, MFA, blocked access or expired session — a human must act; the tool never bypasses these).
Sessions are safe by default: write actions are refused and non-GET requests are blocked at the network layer.
Writes need mode "approved-writes" with an approval and write: true on each write action. Secrets are passed as
\${env:VAR} references. Use ui_observe to see controls (refs like "c12" can be used as targets).`;

const ViewportSchema = z.object({ width: z.number().int().min(200).max(4000), height: z.number().int().min(200).max(4000) });

interface Live {
  op: Operator;
  evidenceDir: string;
  lastUsed: number;
}

const text = (t: string) => ({ type: 'text' as const, text: t });
const errorResult = (msg: string) => ({ content: [text(msg)], isError: true });

export function compactObservation(o: Observation | null, maxControls = 150): Record<string, unknown> | null {
  if (!o) return null;
  return {
    url: o.url,
    title: o.title,
    fingerprint: o.fingerprint,
    headings: o.headings,
    overlays: o.overlays.map((x) => `${x.role}: ${x.name}`),
    alerts: o.alerts,
    focused: o.focused,
    challenge: o.challenge,
    forms: o.forms.map((f) => ({ selector: f.selector, method: f.method, fields: f.fields, submits: f.submits })),
    controls: o.controls.slice(0, maxControls).map((c) => ({
      ref: c.ref,
      role: c.role,
      name: c.name,
      ...(c.href ? { href: c.href } : {}),
      ...(Object.keys(c.state).length ? { state: c.state } : {}),
      ...(c.enabled ? {} : { disabled: true }),
      ...(c.inViewport ? {} : { offscreen: true }),
      ...(c.overlay >= 0 ? { inOverlay: c.overlay } : {}),
      ...(c.submit ? { submit: true } : {}),
    })),
    controlsOmitted: Math.max(0, o.controls.length - maxControls) + (o.truncated ? 1 : 0),
  };
}

function compactResult(r: ActionResult): Record<string, unknown> {
  const e = r.effects;
  return {
    seq: r.seq,
    description: r.description,
    status: r.status,
    reason: r.reason,
    kind: r.kind,
    classification: r.classificationReason,
    expectations: r.expectations,
    attempts: r.attempts,
    interceptedBy: r.interceptedBy,
    challenge: r.challenge,
    effects: e && {
      ...e,
      requests: e.requests.slice(0, 30),
      requestsOmitted: Math.max(0, e.requests.length - 30),
    },
    evidence: r.evidence,
    notes: r.notes,
  };
}

/** Register the browser-operator tools. */
export function registerOperatorTools(server: McpServer, deps: OperatorDeps & { log: (m: string) => void }): void {
  const live = new Map<string, Live>();
  const sweep = setInterval(() => {
    for (const [id, s] of live) {
      if (Date.now() - s.lastUsed > 10 * 60_000) {
        live.delete(id);
        void s.op.close();
      }
    }
  }, 60_000);
  sweep.unref();
  const get = (id: string): Live | null => {
    const s = live.get(id);
    if (s) s.lastUsed = Date.now();
    return s ?? null;
  };

  server.registerTool(
    'ui_login',
    {
      title: 'Create an isolated authorised session for a role',
      description:
        'Register a role (login URL, steps, success checks) and sign in. "scripted" runs the steps in a separate, untraced browser ' +
        'context with secrets taken from ${env:VAR} references; "manual" opens a visible browser window where a human signs in ' +
        '(use it for CAPTCHA/MFA, which this tool never automates). The session (cookies/storage) is saved per role and reused by ui_open, ui_run_workflow and ui_explore.',
      inputSchema: RoleSchema.extend({
        method: z.enum(['scripted', 'manual']).optional(),
        timeoutMs: z.number().int().min(10_000).max(900_000).optional().describe('Manual login wait (default 5 min).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const { method, timeoutMs, ...role } = args;
        deps.sessions.register(role);
        const out = method === 'manual' ? await deps.sessions.loginManual(role.name, timeoutMs ?? 300_000) : await deps.sessions.loginScripted(role.name);
        return { content: [text(JSON.stringify(out, null, 2))], ...(out.status === 'logged-in' ? {} : { isError: false }) };
      } catch (err) {
        return errorResult(err instanceof PolicyError ? err.message : `Login failed: ${(err as Error).message.split('\n')[0]}`);
      }
    },
  );

  server.registerTool(
    'ui_open',
    {
      title: 'Open a verified browser session',
      description:
        'Open an isolated browser session (optionally as a registered role) and navigate to a URL. Safe mode (default) refuses ' +
        'writes and blocks non-GET requests. "approved-writes" requires an approval and, for non-loopback origins, QA_MCP_WRITE_ORIGINS.',
      inputSchema: z.object({
        url: z.string(),
        role: z.string().optional(),
        viewport: ViewportSchema.optional(),
        mode: z.enum(['safe', 'approved-writes']).optional(),
        approval: z.object({ approvedBy: z.string().min(1), reason: z.string().min(1) }).optional(),
        reauth: z.enum(['scripted', 'operator']).optional(),
        trace: z.boolean().optional().describe('Record a Playwright trace (default true).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const sessionId = newRunId('ui');
      try {
        const { op, reason, evidenceDir } = await openOperator(deps, {
          url: args.url,
          role: args.role,
          viewport: args.viewport,
          mode: args.mode ?? 'safe',
          approval: args.approval ?? null,
          reauth: args.reauth ?? 'operator',
          trace: args.trace,
          label: sessionId,
        });
        if (!op) return errorResult(`needs-operator: ${reason}`);
        live.set(sessionId, { op, evidenceDir, lastUsed: Date.now() });
        const r = op.results[0]!;
        return {
          content: [text(JSON.stringify({ sessionId, mode: args.mode ?? 'safe', open: compactResult(r), observation: compactObservation(op.observation), evidenceDir }, null, 2))],
        };
      } catch (err) {
        return errorResult(err instanceof PolicyError ? `refused: ${err.message}` : `Could not open: ${(err as Error).message.split('\n')[0]}`);
      }
    },
  );

  server.registerTool(
    'ui_observe',
    {
      title: 'Observe the current page',
      description: 'Controls (with refs usable as targets), forms, open overlays, live-region messages, headings, focus and any challenge on the current page.',
      inputSchema: z.object({ sessionId: z.string(), maxControls: z.number().int().min(10).max(400).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const s = get(args.sessionId);
      if (!s) return errorResult(`Unknown or closed session ${args.sessionId}.`);
      const o = await s.op.observeNow();
      return { content: [text(JSON.stringify(compactObservation(o, args.maxControls ?? 150), null, 2))] };
    },
  );

  server.registerTool(
    'ui_act',
    {
      title: 'Perform one verified action',
      description:
        'Perform an action (click, fill, type, press, select, check, scroll, drag, upload, navigate, tabs, wait) and verify it: ' +
        'explicit "expect" checks plus the outcome implied by the control. Returns status, attempts, expectation results, ' +
        'effects (navigation, DOM/visual change, requests, dialogs, popups, downloads, console errors) and screenshot evidence.',
      inputSchema: z.object({ sessionId: z.string(), action: OpActionSchema, ...ActOptionsSchema.shape }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const s = get(args.sessionId);
      if (!s) return errorResult(`Unknown or closed session ${args.sessionId}.`);
      const { sessionId: _id, action, ...opts } = args;
      try {
        const r = await s.op.act(action, opts);
        return { content: [text(JSON.stringify({ result: compactResult(r), observation: compactObservation(s.op.observation, 60) }, null, 2))] };
      } catch (err) {
        return errorResult(err instanceof PolicyError ? `refused: ${err.message}` : `Action failed unexpectedly: ${(err as Error).message.split('\n')[0]}`);
      }
    },
  );

  server.registerTool(
    'ui_close',
    {
      title: 'Close a session and write its evidence',
      description: 'Stop tracing, close the browser context and summarise every action (verified vs unverified), writes performed, and evidence files.',
      inputSchema: z.object({ sessionId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const s = live.get(args.sessionId);
      if (!s) return errorResult(`Unknown or closed session ${args.sessionId}.`);
      live.delete(args.sessionId);
      const writes = s.op.writeLedger();
      const results = s.op.results;
      const evidence = await s.op.close();
      const byStatus = results.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
      const disclosures = results
        .filter((r) => r.status !== 'passed')
        .map((r) => `#${r.seq} ${r.description}: ${r.status}${r.status === 'performed' ? ' (not verified)' : ''} — ${r.reason}`);
      return { content: [text(JSON.stringify({ sessionId: args.sessionId, actions: results.length, byStatus, writes, disclosures, evidence: { dir: s.evidenceDir, ...evidence } }, null, 2))] };
    },
  );

  server.registerTool(
    'ui_run_workflow',
    {
      title: 'Run a verified workflow',
      description:
        'Run a multi-step workflow as a role. Each step is verified; the run stops at the first failing non-optional step and ' +
        'reports the rest as not-run. Steps can run the layout engine (auditUi). Writes need workflow.writes approval and write: true per step.',
      inputSchema: z.object({ workflow: WorkflowSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const r = await runWorkflow(deps, args.workflow);
      return { content: [text(JSON.stringify({ ...r, steps: r.steps.map((s) => ({ ...s, result: s.result && compactResult(s.result) })) }, null, 2))] };
    },
  );

  server.registerTool(
    'ui_explore',
    {
      title: 'Explore an application safely',
      description:
        'Budgeted, read-only exploration that builds a state graph from live observations: menus, tabs, disclosures, links and ' +
        'dynamic forms (filled with sample values, never submitted). Reports discovered vs tested vs untested actions with reasons, ' +
        'issues (blocked/failed/no-effect actions, console errors, failed requests, write attempts stopped by the guard) and optional layout findings per state.',
      inputSchema: ExploreSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const r = await explore(deps, args);
      return { content: [text(JSON.stringify(r, null, 2))] };
    },
  );
}
