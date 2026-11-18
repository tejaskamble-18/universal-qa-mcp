import { join } from 'node:path';
import * as z from 'zod';
import type { ConfigFinding } from '../engine/runner.js';
import { describeAction, PolicyError } from '../operator/operator.js';
import { ActOptionsSchema, OpActionSchema, type ActionResult, type ActionStatus } from '../operator/types.js';
import type { RunConfigInfo } from '../report/schema.js';
import { analyzeLivePage } from '../engine/runner.js';
import { newRunId, openOperator, type OperatorDeps } from '../operator/open.js';

export const WorkflowStepSchema = z.object({
  id: z.string().optional(),
  description: z.string().optional(),
  action: OpActionSchema,
  ...ActOptionsSchema.shape,
  optional: z.boolean().optional().describe('A failure of this step does not stop the workflow.'),
  auditUi: z.boolean().optional().describe('Run the layout engine on the page after this step.'),
});

export const WorkflowSchema = z.object({
  name: z.string(),
  role: z.string().optional().describe('Registered role whose isolated session is used.'),
  startUrl: z.string(),
  viewport: z.object({ width: z.number().int().min(200).max(4000), height: z.number().int().min(200).max(4000) }).optional(),
  writes: z
    .object({ approvedBy: z.string().min(1), reason: z.string().min(1) })
    .optional()
    .describe('Approval for steps marked write: true. Without it the session runs in safe mode.'),
  reauth: z.enum(['scripted', 'operator']).optional().describe("On session expiry: re-run the role's scripted login, or stop for a human (default)."),
  steps: z.array(WorkflowStepSchema).min(1).max(200),
});
export type WorkflowDef = z.infer<typeof WorkflowSchema>;

export type StepStatus = ActionStatus | 'not-run';

export interface StepReport {
  index: number;
  id: string;
  description: string;
  status: StepStatus;
  verified: boolean;
  reason: string;
  result: ActionResult | null;
  ui: { findings: { id: string; category: string; title: string; status: string; severity: string; elements: string[] }[]; evidenceDir: string } | null;
}

export interface WorkflowReport {
  runId: string;
  name: string;
  role: string | null;
  mode: 'safe' | 'approved-writes';
  startedAt: string;
  finishedAt: string;
  status: 'passed' | 'failed' | 'blocked' | 'needs-operator' | 'incomplete';
  summary: Record<StepStatus, number>;
  open: { status: string; reason: string } | null;
  steps: StepReport[];
  disclosures: string[];
  writes: { key: string; status: string; description: string }[];
  config: RunConfigInfo | null;
  evidence: { dir: string; trace: string | null; eventLog: string | null; actionsLog: string | null };
}

const STOPPING: ActionStatus[] = ['failed', 'blocked', 'refused', 'duplicate-prevented', 'needs-operator', 'outcome-unknown', 'no-effect'];

function uiSummary(findings: ConfigFinding[]): NonNullable<StepReport['ui']>['findings'] {
  return findings.map((f) => ({
    id: f.key,
    category: f.category,
    title: f.title,
    status: f.status,
    severity: f.severity,
    elements: f.elements.map((e) => `${e.role}:${e.selector}`),
  }));
}

/**
 * Run a workflow: every step is executed through the operator and verified
 * (explicit expectations plus the control's intrinsic outcome). The run stops
 * at the first non-optional step that did not pass or perform; the remaining
 * steps are reported as not-run. Nothing is reported as passed unless checked.
 */
export async function runWorkflow(deps: OperatorDeps, def: WorkflowDef): Promise<WorkflowReport> {
  const runId = newRunId('wf');
  const startedAt = new Date().toISOString();
  const mode = def.writes ? 'approved-writes' : 'safe';
  const report: WorkflowReport = {
    runId,
    name: def.name,
    role: def.role ?? null,
    mode,
    startedAt,
    finishedAt: startedAt,
    status: 'incomplete',
    summary: {} as Record<StepStatus, number>,
    open: null,
    steps: [],
    disclosures: [],
    writes: [],
    config: null,
    evidence: { dir: join(deps.artifactsRoot, runId), trace: null, eventLog: null, actionsLog: null },
  };
  const notRun = (from: number, why: string): void => {
    for (let k = from; k < def.steps.length; k++) {
      const s = def.steps[k]!;
      report.steps.push({ index: k, id: s.id ?? `step-${k + 1}`, description: s.description ?? describeAction(s.action), status: 'not-run', verified: false, reason: why, result: null, ui: null });
    }
  };

  let opened;
  try {
    opened = await openOperator(deps, {
      url: def.startUrl,
      role: def.role,
      viewport: def.viewport,
      mode,
      approval: def.writes ?? null,
      reauth: def.reauth ?? 'operator',
      label: runId,
    });
  } catch (err) {
    const why = err instanceof PolicyError ? `refused: ${err.message}` : `could not open the session: ${(err as Error).message.split('\n')[0]}`;
    report.open = { status: err instanceof PolicyError ? 'refused' : 'failed', reason: why };
    notRun(0, why);
    return finalize(report);
  }
  const { op } = opened;
  if (!op) {
    report.open = { status: 'needs-operator', reason: opened.reason };
    notRun(0, opened.reason);
    return finalize(report);
  }
  report.config = op.config;
  const first = op.results[0]!;
  report.open = { status: first.status, reason: first.reason };

  try {
    if (!['passed', 'performed'].includes(first.status)) {
      notRun(0, `opening ${def.startUrl} ${first.status}: ${first.reason}`);
      return finalize(report);
    }
    for (const [k, s] of def.steps.entries()) {
      const r = await op.act(s.action, s);
      const verified = r.status === 'passed';
      let ui: StepReport['ui'] = null;
      if (s.auditUi) {
        const dir = join(report.evidence.dir, 'ui', `step-${k + 1}`);
        const a = await analyzeLivePage(op.page, op.config, dir);
        ui = { findings: uiSummary(a.findings), evidenceDir: dir };
      }
      report.steps.push({
        index: k,
        id: s.id ?? `step-${k + 1}`,
        description: s.description ?? r.description,
        status: r.status,
        verified,
        reason: r.reason,
        result: r,
        ui,
      });
      if (STOPPING.includes(r.status) && !s.optional) {
        notRun(k + 1, `not run: step ${k + 1} (${s.id ?? r.description}) ended ${r.status}`);
        break;
      }
    }
  } finally {
    report.writes = op.writeLedger();
    const closed = await op.close();
    report.evidence = { dir: report.evidence.dir, ...closed };
  }
  return finalize(report);
}

function finalize(r: WorkflowReport): WorkflowReport {
  r.finishedAt = new Date().toISOString();
  const summary = {} as Record<StepStatus, number>;
  for (const s of r.steps) summary[s.status] = (summary[s.status] ?? 0) + 1;
  r.summary = summary;
  const required = r.steps.filter((s) => s.status !== 'not-run');
  const has = (st: StepStatus): boolean => r.steps.some((s) => s.status === st);
  if (r.open && !['passed', 'performed'].includes(r.open.status)) {
    r.status = r.open.status === 'needs-operator' ? 'needs-operator' : r.open.status === 'blocked' ? 'blocked' : 'failed';
  } else if (has('needs-operator')) r.status = 'needs-operator';
  else if (has('blocked')) r.status = 'blocked';
  else if (['failed', 'refused', 'duplicate-prevented', 'outcome-unknown', 'no-effect'].some((st) => has(st as StepStatus))) r.status = 'failed';
  else if (required.length === r.steps.length && r.steps.every((s) => s.status === 'passed')) r.status = 'passed';
  else r.status = 'incomplete';

  const d = r.disclosures;
  if (r.open && !['passed', 'performed'].includes(r.open.status)) d.push(`Session did not open: ${r.open.reason}`);
  for (const s of r.steps) {
    if (s.status === 'passed') continue;
    if (s.status === 'performed') d.push(`Step ${s.index + 1} (${s.id}) was executed but NOT verified: no expected outcome was specified or derivable.`);
    else if (s.status === 'not-run') d.push(`Step ${s.index + 1} (${s.id}) was not run: ${s.reason}`);
    else d.push(`Step ${s.index + 1} (${s.id}) ${s.status}: ${s.reason}`);
  }
  for (const s of r.steps) {
    const e = s.result?.effects;
    if (!e) continue;
    if (!e.settled) d.push(`Step ${s.index + 1}: the UI did not settle before verification.`);
    const blocked = e.requests.filter((q) => q.blockedByGuard && q.blockedByGuard !== 'duplicate-write');
    if (blocked.length) d.push(`Step ${s.index + 1}: the network guard blocked ${blocked.length} write request(s) (${blocked[0]!.method} ${blocked[0]!.url}).`);
    if (e.consoleErrors.length || e.pageErrors.length) d.push(`Step ${s.index + 1}: ${e.consoleErrors.length + e.pageErrors.length} console/page error(s): ${[...e.pageErrors, ...e.consoleErrors][0]}`);
    const failedReq = e.requests.filter((q) => !q.blockedByGuard && (q.failure || (q.status ?? 0) >= 400));
    if (failedReq.length) d.push(`Step ${s.index + 1}: ${failedReq.length} request(s) failed (${failedReq.map((q) => `${q.method} ${q.url} → ${q.failure ?? q.status}`).slice(0, 2).join('; ')}).`);
  }
  for (const w of r.writes) if (w.status === 'unknown') d.push(`Write with unconfirmed outcome (not retried): ${w.description}. Verify server state before repeating it.`);
  return r;
}
