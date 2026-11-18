import type { ActionStatus, Challenge, Observation } from '../operator/types.js';
import type { Candidate, CandidateStatus } from './planner.js';

export interface StateNode {
  id: string;
  fingerprint: string;
  url: string;
  route: string;
  title: string;
  headings: string[];
  depth: number;
  /** Candidates to replay from the start URL to reach this state. */
  path: Candidate[];
  via: string;
  screenshot: string | null;
  controls: number;
  overlays: string[];
  challenge: Challenge | null;
  candidates: (Candidate & { resultStatus?: ActionStatus; to?: string; resultReason?: string })[];
  ui: { findings: { category: string; title: string; status: string; severity: string; elements: string[] }[]; evidenceDir: string } | null;
}

export interface Edge {
  from: string;
  to: string;
  via: string;
  status: ActionStatus;
  reason: string;
}

/** Abstract UI states (by observation fingerprint) and the actions between them. */
export class StateGraph {
  readonly states = new Map<string, StateNode>();
  readonly edges: Edge[] = [];
  private byFingerprint = new Map<string, string>();

  has(fingerprint: string): boolean {
    return this.byFingerprint.has(fingerprint);
  }

  get(id: string): StateNode {
    const s = this.states.get(id);
    if (!s) throw new Error(`unknown state ${id}`);
    return s;
  }

  byFp(fingerprint: string): StateNode | undefined {
    const id = this.byFingerprint.get(fingerprint);
    return id ? this.states.get(id) : undefined;
  }

  add(obs: Observation, depth: number, path: Candidate[], via: string, screenshot: string | null): { node: StateNode; isNew: boolean } {
    const existing = this.byFp(obs.fingerprint);
    if (existing) return { node: existing, isNew: false };
    const id = `S${this.states.size}`;
    const node: StateNode = {
      id,
      fingerprint: obs.fingerprint,
      url: obs.url,
      route: obs.route,
      title: obs.title,
      headings: obs.headings,
      depth,
      path,
      via,
      screenshot,
      controls: obs.controls.length,
      overlays: obs.overlays.map((o) => `${o.role}:${o.name}`),
      challenge: obs.challenge,
      candidates: [],
      ui: null,
    };
    this.states.set(id, node);
    this.byFingerprint.set(obs.fingerprint, id);
    return { node, isNew: true };
  }

  /** Next untested candidate: shallowest state first, then highest priority. */
  next(): { state: StateNode; cand: StateNode['candidates'][number] } | null {
    let best: { state: StateNode; cand: StateNode['candidates'][number] } | null = null;
    for (const s of this.states.values()) {
      for (const c of s.candidates) {
        if (c.status !== 'untested') continue;
        if (!best || s.depth < best.state.depth || (s.depth === best.state.depth && c.priority > best.cand.priority)) best = { state: s, cand: c };
      }
    }
    return best;
  }

  markRemaining(status: CandidateStatus, reason: string): void {
    for (const s of this.states.values()) {
      for (const c of s.candidates) {
        if (c.status === 'untested') {
          c.status = status;
          c.reason = reason;
        }
      }
    }
  }

  coverage(): { states: number; edges: number; actionsDiscovered: number; actionsTested: number; byStatus: Record<string, number> } {
    const byStatus: Record<string, number> = {};
    let discovered = 0;
    for (const s of this.states.values()) {
      for (const c of s.candidates) {
        discovered++;
        byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
      }
    }
    return { states: this.states.size, edges: this.edges.length, actionsDiscovered: discovered, actionsTested: byStatus.tested ?? 0, byStatus };
  }
}
