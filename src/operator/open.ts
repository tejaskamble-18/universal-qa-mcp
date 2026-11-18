import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserManager, ConfigRequest } from '../browser/session.js';
import { OPERATOR_DEFAULTS, Operator, type OperatorMode, type OperatorOptions } from './operator.js';
import type { SessionStore } from './sessions.js';
import type { TargetPolicy } from '../safety/policy.js';

/** Everything the exploration and workflow layers need to drive browser sessions. */
export interface OperatorDeps {
  browsers: BrowserManager;
  policy: TargetPolicy;
  sessions: SessionStore;
  artifactsRoot: string;
  writeOrigins: string[];
  uploadRoots: string[];
  /** Overrides for operator timeouts/evidence settings (e.g. shorter timeouts in tests). */
  defaults?: Partial<typeof OPERATOR_DEFAULTS>;
}

export interface OpenRequest {
  url: string;
  role?: string;
  viewport?: { width: number; height: number };
  zoom?: number;
  mode: OperatorMode;
  approval?: { approvedBy: string; reason: string } | null;
  /** 'scripted' re-runs the role's login when the session expires; 'operator' stops and asks a human. */
  reauth?: 'scripted' | 'operator';
  trace?: boolean;
  label: string;
}

export function newRunId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`;
}

/**
 * Open an operator session for a role. Returns null with a reason when the
 * role has no stored session and cannot log in without a human.
 */
export async function openOperator(deps: OperatorDeps, req: OpenRequest): Promise<{ op: Operator | null; reason: string; evidenceDir: string }> {
  const evidenceDir = join(deps.artifactsRoot, req.label);
  mkdirSync(evidenceDir, { recursive: true });
  let storageState: string | undefined;
  if (req.role) {
    if (!deps.sessions.hasState(req.role)) {
      const role = deps.sessions.role(req.role);
      if (!role) return { op: null, reason: `Role ${req.role} is not registered; register it with ui_login first.`, evidenceDir };
      const login = await deps.sessions.loginScripted(req.role);
      if (login.status !== 'logged-in') return { op: null, reason: `Login for role ${req.role} ${login.status}: ${login.reason}`, evidenceDir };
    }
    storageState = deps.sessions.statePath(req.role);
  }
  const config: ConfigRequest = {
    width: req.viewport?.width ?? 1280,
    height: req.viewport?.height ?? 800,
    zoom: req.zoom ?? 1,
    colorScheme: 'light',
  };
  const roleCfg = req.role ? deps.sessions.role(req.role) : undefined;
  const opts: OperatorOptions = {
    ...OPERATOR_DEFAULTS,
    ...deps.defaults,
    sessionId: req.label,
    role: req.role ?? null,
    mode: req.mode,
    approval: req.approval ?? null,
    policy: deps.policy,
    writeOrigins: deps.writeOrigins,
    uploadRoots: deps.uploadRoots,
    evidenceDir,
    trace: req.trace ?? true,
    loginUrlPattern: roleCfg?.loginUrlPattern ?? null,
    reauth: req.role && req.reauth === 'scripted' ? deps.sessions.reauthFor(req.role) : null,
  };
  const op = await Operator.open(deps.browsers, config, req.url, opts, storageState);
  return { op, reason: '', evidenceDir };
}

