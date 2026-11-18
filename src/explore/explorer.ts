import { join } from 'node:path';
import * as z from 'zod';
import { analyzeLivePage } from '../engine/runner.js';
import { newRunId, openOperator, type OperatorDeps } from '../operator/open.js';
import { PolicyError, type Operator } from '../operator/operator.js';
import type { ActionResult, ActionStatus } from '../operator/types.js';
import type { RunConfigInfo } from '../report/schema.js';
import { StateGraph, type Edge, type StateNode } from './graph.js';
import { plan, type Candidate } from './planner.js';

export const ExploreSchema = z.object({
  url: z.string().describe('Start URL.'),
  role: z.string().optional(),
  viewport: z.object({ width: z.number().int().min(200).max(4000), height: z.number().int().min(200).max(4000) }).optional(),
  pathPrefix: z.string().optional().describe('Only follow links under this path (default: whole origin).'),
  maxStates: z.number().int().min(1).max(200).optional(),
  maxActions: z.number().int().min(1).max(1000).optional(),
  maxDepth: z.number().int().min(1).max(10).optional(),
  maxMinutes: z.number().min(0.5).max(60).optional(),
  sampleSimilar: z.number().int().min(1).max(10).optional().describe('How many repetitive items (list rows etc.) to try per group.'),
  auditUi: z.boolean().optional().describe('Run the layout engine on every newly discovered state.'),
});
export type ExploreOptions = z.infer<typeof ExploreSchema>;

export interface ExploreIssue {
  kind: 'blocked' | 'failed' | 'no-effect' | 'needs-operator' | 'console-error' | 'failed-request' | 'guard-blocked-write' | 'ui-finding';
  state: string;
  description: string;
  detail: string;
}

export interface ExploreReport {
  runId: string;
  startUrl: string;
  role: string | null;
  mode: 'safe';
  startedAt: string;
  finishedAt: string;
  stoppedBecause: string;
  budget: { maxStates: number; maxActions: number; maxDepth: number; maxMinutes: number; actionsUsed: number };
  coverage: ReturnType<StateGraph['coverage']>;
  states: Omit<StateNode, 'path' | 'candidates'>[];
  edges: Edge[];
  actions: { state: string; key: string; description: string; kind: string; status: string; reason: string; result: ActionStatus | null; to: string | null }[];
  issues: ExploreIssue[];
  disclosures: string[];
  config: RunConfigInfo | null;
  evidence: { dir: string; trace: string | null; eventLog: string | null; actionsLog: string | null };
}

const OK: ActionStatus[] = ['passed', 'performed', 'no-effect'];

/**
 * Safe, budgeted exploration. Builds a state graph from live observations:
 * each state's candidate actions are planned from what is on screen, executed
 * (re-reaching the state by replaying its path from a fresh load when needed),
 * verified, and recorded. Writes are never performed; every action that was not
 * tried is listed with the reason.
 */
export async function explore(deps: OperatorDeps, o: ExploreOptions): Promise<ExploreReport> {
  const runId = newRunId('explore');
  const startedAt = Date.now();
  const budget = {
    maxStates: o.maxStates ?? 25,
    maxActions: o.maxActions ?? 120,
    maxDepth: o.maxDepth ?? 4,
    maxMinutes: o.maxMinutes ?? 5,
    actionsUsed: 0,
  };
  const graph = new StateGraph();
  const issues: ExploreIssue[] = [];
  const disclosures: string[] = [];
  const report = (stoppedBecause: string, op: Operator | null, evidence: ExploreReport['evidence']): ExploreReport => {
    const states = [...graph.states.values()];
    return {
      runId,
      startUrl: o.url,
      role: o.role ?? null,
      mode: 'safe',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      stoppedBecause,
      budget,
      coverage: graph.coverage(),
      states: states.map(({ path: _p, candidates: _c, ...rest }) => rest),
      edges: graph.edges,
      actions: states.flatMap((s) =>
        s.candidates.map((c) => ({
          state: s.id,
          key: c.key,
          description: c.description,
          kind: c.kind,
          status: c.status,
          reason: c.reason,
          result: c.resultStatus ?? null,
          to: c.to ?? null,
        })),
      ),
      issues,
      disclosures,
      config: op?.config ?? null,
      evidence,
    };
  };

  let opened;
  try {
    opened = await openOperator(deps, { url: o.url, role: o.role, viewport: o.viewport, mode: 'safe', reauth: 'operator', label: runId });
  } catch (err) {
    const why = err instanceof PolicyError ? `refused: ${err.message}` : `could not open: ${(err as Error).message.split('\n')[0]}`;
    disclosures.push(why);
    return report(why, null, { dir: join(deps.artifactsRoot, runId), trace: null, eventLog: null, actionsLog: null });
  }
  const { op, evidenceDir } = opened;
  if (!op) {
    disclosures.push(opened.reason);
    return report(opened.reason, null, { dir: evidenceDir, trace: null, eventLog: null, actionsLog: null });
  }

  let stoppedBecause = 'no untested actions remain';
  const start = new URL(op.page.url());
  const scope = { origin: start.origin, pathPrefix: o.pathPrefix ?? '/' };
  const sample = o.sampleSimilar ?? 2;
  // Global chrome (header nav, menus present on every page) is explored once, from the first state it was tried in.
  const testedGlobally = new Map<string, string>();

  const addState = async (r: ActionResult | null, depth: number, path: Candidate[], via: string): Promise<StateNode> => {
    const obs = op.observation ?? (await op.observeNow());
    const { node, isNew } = graph.add(obs, depth, path, via, r?.evidence.after ?? null);
    if (isNew) {
      node.candidates = depth >= budget.maxDepth
        ? plan(node.id, obs, scope, sample).map((c) => (c.status === 'untested' ? { ...c, status: 'skipped-depth' as const, reason: `state depth ${depth} reached maxDepth` } : c))
        : plan(node.id, obs, scope, sample);
      if (obs.challenge) {
        node.candidates = node.candidates.map((c) => (c.status === 'untested' ? { ...c, status: 'halted' as const, reason: `${obs.challenge!.kind} challenge on this page` } : c));
      }
      if (o.auditUi && !obs.challenge) {
        const dir = join(evidenceDir, 'ui', node.id);
        const a = await analyzeLivePage(op.page, op.config, dir);
        node.ui = {
          evidenceDir: dir,
          findings: a.findings.map((f) => ({ category: f.category, title: f.title, status: f.status, severity: f.severity, elements: f.elements.map((e) => `${e.role}:${e.selector}`) })),
        };
        for (const f of a.findings) {
          issues.push({ kind: 'ui-finding', state: node.id, description: `${f.status} ${f.severity} ${f.category}: ${f.title}`, detail: f.description });
        }
      }
    }
    return node;
  };

  const noteIssues = (state: string, r: ActionResult, label: string): void => {
    if (r.status === 'blocked' || r.status === 'failed' || r.status === 'no-effect' || r.status === 'needs-operator') {
      issues.push({ kind: r.status, state, description: label, detail: r.reason + (r.interceptedBy ? ` (intercepted by ${r.interceptedBy})` : '') });
    }
    const e = r.effects;
    if (!e) return;
    for (const err of [...e.pageErrors, ...e.consoleErrors]) issues.push({ kind: 'console-error', state, description: label, detail: err });
    for (const q of e.requests) {
      if (q.blockedByGuard && q.blockedByGuard !== 'duplicate-write') {
        issues.push({ kind: 'guard-blocked-write', state, description: label, detail: `${q.method} ${q.url} was blocked (${q.blockedByGuard}): this action tried to write although it was classified as ${r.kind}` });
      } else if (!q.blockedByGuard && (q.failure || (q.status ?? 0) >= 400)) {
        issues.push({ kind: 'failed-request', state, description: label, detail: `${q.method} ${q.url} → ${q.failure ?? q.status}` });
      }
    }
  };

  /** Fresh load of the start URL, then replay the state's path; true if we land in the same state. */
  const reach = async (s: StateNode): Promise<boolean> => {
    const nav = await op.act({ type: 'navigate', url: o.url });
    budget.actionsUsed++;
    if (!OK.includes(nav.status)) return false;
    for (const c of s.path) {
      for (const a of c.actions) {
        const r = await op.act(a);
        budget.actionsUsed++;
        if (!OK.includes(r.status)) return false;
      }
    }
    return (op.observation ?? (await op.observeNow())).fingerprint === s.fingerprint;
  };

  try {
    await addState(op.results[0] ?? null, 0, [], 'start');
    let currentFp = op.observation?.fingerprint ?? '';
    for (;;) {
      if (graph.states.size >= budget.maxStates) {
        stoppedBecause = `maxStates (${budget.maxStates}) reached`;
        break;
      }
      if (budget.actionsUsed >= budget.maxActions) {
        stoppedBecause = `maxActions (${budget.maxActions}) reached`;
        break;
      }
      if (Date.now() - startedAt > budget.maxMinutes * 60_000) {
        stoppedBecause = `maxMinutes (${budget.maxMinutes}) reached`;
        break;
      }
      const next = graph.next();
      if (!next) break;
      const { state, cand } = next;
      const seenIn = testedGlobally.get(cand.globalKey);
      if (seenIn) {
        cand.status = 'skipped-similar';
        cand.reason = `same control/destination already explored from state ${seenIn} (${cand.globalKey})`;
        continue;
      }
      if (currentFp !== state.fingerprint && !(await reach(state))) {
        cand.status = 'unreachable';
        cand.reason = `could not re-reach state ${state.id} by replaying its path from the start URL`;
        currentFp = op.observation?.fingerprint ?? '';
        if (op.haltedBy) break;
        continue;
      }
      let last: ActionResult | null = null;
      for (const a of cand.actions) {
        last = await op.act(a);
        budget.actionsUsed++;
        noteIssues(state.id, last, cand.description);
        if (!OK.includes(last.status)) break;
      }
      cand.status = 'tested';
      testedGlobally.set(cand.globalKey, state.id);
      cand.resultStatus = last!.status;
      cand.resultReason = last!.reason;

      // Popups are recorded, not explored; close them and continue in the main tab.
      for (const url of last!.effects?.popups ?? []) {
        graph.edges.push({ from: state.id, to: `popup:${url}`, via: cand.description, status: last!.status, reason: 'opened a new tab/window (recorded, not explored)' });
      }
      while (op.pages.filter((p) => !p.isClosed()).length > 1) {
        const live = op.pages.filter((p) => !p.isClosed());
        await live[live.length - 1]!.close();
      }

      const halted = op.haltedBy;
      if (halted) {
        const obs = op.observation;
        const target = await addState(last, state.depth + 1, [...state.path, cand], cand.description);
        cand.to = target.id;
        graph.edges.push({ from: state.id, to: target.id, via: cand.description, status: last!.status, reason: last!.reason });
        if (halted.kind === 'captcha' || halted.kind === 'mfa') {
          // Do not interact with the challenge; leave that page and continue elsewhere.
          disclosures.push(`State ${target.id} (${obs?.url}) shows a ${halted.kind} challenge; it was not interacted with and needs an operator.`);
          op.resume();
          currentFp = '';
          continue;
        }
        stoppedBecause = `${halted.kind}: ${halted.reason} Exploration stopped to respect the site's restrictions.`;
        break;
      }
      if (!OK.includes(last!.status)) {
        currentFp = op.observation?.fingerprint ?? '';
        continue;
      }
      const target = await addState(last, state.depth + 1, [...state.path, cand], cand.description);
      cand.to = target.id;
      graph.edges.push({ from: state.id, to: target.id, via: cand.description, status: last!.status, reason: last!.reason });
      currentFp = op.observation?.fingerprint ?? '';
    }
  } catch (err) {
    stoppedBecause = `aborted by an unexpected error: ${(err as Error).message.split('\n')[0]}`;
  }
  const closed = await op.close();
  graph.markRemaining('skipped-budget', `not tried: exploration stopped (${stoppedBecause})`);
  const r = report(stoppedBecause, op, { dir: evidenceDir, ...closed });
  finalizeDisclosures(r);
  return r;
}

function finalizeDisclosures(r: ExploreReport): void {
  const d = r.disclosures;
  d.push(`Exploration stopped: ${r.stoppedBecause}.`);
  d.push('Exploration is read-only: write actions were not performed, forms were filled with sample values but never submitted.');
  const by = r.coverage.byStatus;
  const untested = Object.entries(by).filter(([k]) => k !== 'tested');
  if (untested.length) d.push(`Untested actions: ${untested.map(([k, v]) => `${v} ${k}`).join(', ')} (of ${r.coverage.actionsDiscovered} discovered).`);
  const unexplored = r.states.filter((s) => s.challenge);
  for (const s of unexplored) d.push(`State ${s.id} (${s.url}) was not explored: ${s.challenge!.kind} — ${s.challenge!.reason}`);
  if (r.issues.some((i) => i.kind === 'guard-blocked-write')) d.push('Some actions classified as reads attempted write requests; the network guard blocked them (see issues).');
}
