import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { BrowserManager, type ConfigRequest } from '../browser/session.js';
import type { TargetPolicy } from '../safety/policy.js';
import { OPERATOR_DEFAULTS, Operator, PolicyError, type OperatorOptions } from './operator.js';
import { ExpectationSchema, OpActionSchema, type ActionResult, type Expectation, type OpAction } from './types.js';

export const RoleSchema = z.object({
  name: z.string().regex(/^[\w.-]{1,40}$/, 'role names use letters, digits, "_", "." or "-"'),
  loginUrl: z.string(),
  steps: z.array(OpActionSchema).max(20).describe('Scripted login steps; secrets must be ${env:VAR} references.'),
  success: z.array(ExpectationSchema).min(1).max(10).describe('Expectations that prove the login worked.'),
  loginUrlPattern: z.string().optional().describe('Regex matching the login page URL (detects expired sessions).'),
});
export type RoleConfig = z.infer<typeof RoleSchema>;

export interface LoginOutcome {
  role: string;
  status: 'logged-in' | 'failed' | 'needs-operator';
  reason: string;
  steps: { description: string; status: string; reason: string }[];
}

const SECRET_FIELD = /pass(word)?|secret|token|otp|one-time|2fa|mfa|code|pin\b/i;

/** A login step that types into a secret-looking field must reference an environment variable. */
function assertNoLiteralSecrets(steps: OpAction[]): void {
  for (const s of steps) {
    if (s.type !== 'fill' && s.type !== 'type') continue;
    const t = s.target ?? {};
    const hint = [t.label, t.name, t.placeholder, t.selector, t.testId].filter(Boolean).join(' ');
    const value = s.type === 'fill' ? s.value : s.text;
    if (SECRET_FIELD.test(hint) && !/^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) {
      throw new PolicyError(`Login secrets must be passed as \${env:VAR} references, not literal values (field: ${hint}).`);
    }
  }
}

/**
 * Isolated authorised sessions, one per role. Each role's cookies/localStorage
 * are saved to its own storage-state file and only ever loaded into that
 * role's contexts. Logins run in a separate, untraced context so credentials
 * never reach traces, screenshots or logs.
 */
export class SessionStore {
  private roles = new Map<string, RoleConfig>();

  constructor(
    readonly dir: string,
    private readonly browsers: BrowserManager,
    private readonly policy: TargetPolicy,
    private readonly viewport: ConfigRequest = { width: 1280, height: 800, zoom: 1, colorScheme: 'light' },
  ) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'roles.json');
    if (existsSync(file)) {
      for (const r of JSON.parse(readFileSync(file, 'utf8')) as RoleConfig[]) this.roles.set(r.name, r);
    }
  }

  register(role: RoleConfig): void {
    assertNoLiteralSecrets(role.steps);
    this.roles.set(role.name, role);
    writeFileSync(join(this.dir, 'roles.json'), JSON.stringify([...this.roles.values()], null, 2));
  }

  role(name: string): RoleConfig | undefined {
    return this.roles.get(name);
  }

  statePath(name: string): string {
    return join(this.dir, `${name}.storage.json`);
  }

  hasState(name: string): boolean {
    return existsSync(this.statePath(name));
  }

  private loginOptions(name: string, role: RoleConfig): OperatorOptions {
    return {
      ...OPERATOR_DEFAULTS,
      sessionId: `login-${name}-${Date.now()}`,
      role: null,
      mode: 'login',
      approval: null,
      policy: this.policy,
      writeOrigins: [],
      uploadRoots: [],
      evidenceDir: null,
      screenshots: false,
      trace: false,
      loginUrlPattern: role.loginUrlPattern ?? null,
      reauth: null,
    };
  }

  private save(op: Operator, name: string): Promise<unknown> {
    const path = this.statePath(name);
    return op.context.storageState({ path }).then(() => {
      try {
        chmodSync(path, 0o600);
      } catch {
        // best effort on platforms without POSIX permissions
      }
    });
  }

  /** Run the role's scripted login in a fresh, untraced context and save the session. */
  async loginScripted(name: string): Promise<LoginOutcome> {
    const role = this.roles.get(name);
    if (!role) return { role: name, status: 'failed', reason: `Role ${name} is not registered.`, steps: [] };
    if (!role.steps.length) return { role: name, status: 'needs-operator', reason: `Role ${name} has no scripted steps; use a manual (operator) login.`, steps: [] };
    const op = await Operator.open(this.browsers, this.viewport, role.loginUrl, this.loginOptions(name, role));
    const log = (r: ActionResult) => ({ description: r.description, status: r.status, reason: r.reason });
    const steps = [log(op.results[0]!)];
    try {
      if (op.haltedBy) return { role: name, status: 'needs-operator', reason: op.haltedBy.reason, steps };
      for (const s of role.steps) {
        const r = await op.act(s);
        steps.push(log(r));
        if (r.status === 'needs-operator') return { role: name, status: 'needs-operator', reason: r.reason, steps };
        if (!['passed', 'performed'].includes(r.status)) return { role: name, status: 'failed', reason: `${r.description}: ${r.reason}`, steps };
      }
      const check = await op.act({ type: 'wait', ms: 0 }, { expect: role.success, expectTimeoutMs: 8000 });
      steps.push(log(check));
      if (check.status !== 'passed') return { role: name, status: check.status === 'needs-operator' ? 'needs-operator' : 'failed', reason: `login success check: ${check.reason}`, steps };
      await this.save(op, name);
      return { role: name, status: 'logged-in', reason: 'success expectations verified; session saved', steps };
    } finally {
      await op.close();
    }
  }

  /**
   * Operator-assisted login: opens a visible browser window where a human signs in
   * (including any CAPTCHA or MFA, which this tool never automates), and saves the
   * session once the success expectations hold.
   */
  async loginManual(name: string, timeoutMs: number): Promise<LoginOutcome> {
    const role = this.roles.get(name);
    if (!role) return { role: name, status: 'failed', reason: `Role ${name} is not registered.`, steps: [] };
    const headed = new BrowserManager({ headless: false });
    try {
      const op = await Operator.open(headed, this.viewport, role.loginUrl, { ...this.loginOptions(name, role), actionTimeoutMs: 2000 });
      op.resume(); // a challenge on the login page is exactly what the human is here to handle
      const deadline = Date.now() + timeoutMs;
      try {
        while (Date.now() < deadline) {
          const r = await op.act({ type: 'wait', ms: 1000 }, { expect: role.success, expectTimeoutMs: 1000 });
          op.resume();
          if (r.status === 'passed') {
            await this.save(op, name);
            return { role: name, status: 'logged-in', reason: 'operator completed the login; session saved', steps: [] };
          }
        }
        return { role: name, status: 'failed', reason: `success expectations not met within ${timeoutMs}ms`, steps: [] };
      } finally {
        await op.close();
      }
    } finally {
      await headed.close();
    }
  }

  /** Re-authentication hook for an operator: scripted login elsewhere, then load the fresh session. */
  reauthFor(name: string): ((op: Operator) => Promise<boolean>) | null {
    const role = this.roles.get(name);
    if (!role || !role.steps.length) return null;
    return async (op) => {
      const out = await this.loginScripted(name);
      if (out.status !== 'logged-in') return false;
      await op.applyStorageState(JSON.parse(readFileSync(this.statePath(name), 'utf8')));
      return true;
    };
  }

  successOf(name: string): Expectation[] {
    return this.roles.get(name)?.success ?? [];
  }
}
