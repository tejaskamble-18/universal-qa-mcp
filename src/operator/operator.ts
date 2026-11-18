import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, isAbsolute } from 'node:path';
import type { BrowserContext, Dialog, Locator, Page, Request, Route } from 'playwright';
import type { PNG } from 'pngjs';
import type { BrowserManager, ConfigRequest } from '../browser/session.js';
import { decode, diffCount } from '../evidence/png.js';
import { evaluateExpectations, intrinsicExpectations } from '../functional/expectations.js';
import type { RunConfigInfo } from '../report/schema.js';
import { checkUrl, type TargetPolicy } from '../safety/policy.js';
import { classifyAction, idempotentRead } from './classify.js';
import { EventRecorder, Redactor } from './events.js';
import { describeTarget, locate, targetInfo, TargetError, type TargetInfo } from './locate.js';
import { loadObserverSource, observe, settle } from './observe.js';
import type {
  ActionEffects,
  ActionResult,
  ActionStatus,
  ActOptions,
  Attempt,
  Challenge,
  ExpectationResult,
  Observation,
  OpAction,
  Target,
} from './types.js';

export type OperatorMode = 'safe' | 'approved-writes' | 'login';

export interface OperatorOptions {
  sessionId: string;
  role: string | null;
  mode: OperatorMode;
  approval: { approvedBy: string; reason: string } | null;
  policy: TargetPolicy;
  /** Non-loopback origins where writes may be approved (QA_MCP_WRITE_ORIGINS). */
  writeOrigins: string[];
  /** Directories files may be uploaded from. */
  uploadRoots: string[];
  evidenceDir: string | null;
  screenshots: boolean;
  trace: boolean;
  actionTimeoutMs: number;
  expectTimeoutMs: number;
  settleQuietMs: number;
  settleTimeoutMs: number;
  /** Regexes for non-GET requests that are known to be read-only (e.g. a search POST). */
  readOnlyRequestPatterns: string[];
  /** Regex for the login page URL; landing there unexpectedly means the session expired. */
  loginUrlPattern: string | null;
  /** Re-authenticate this session (scripted login in a separate context); null = ask the operator. */
  reauth: ((op: Operator) => Promise<boolean>) | null;
}

export const OPERATOR_DEFAULTS = {
  screenshots: true,
  trace: true,
  actionTimeoutMs: 5000,
  expectTimeoutMs: 4000,
  settleQuietMs: 250,
  settleTimeoutMs: 6000,
  readOnlyRequestPatterns: [] as string[],
};

export class PolicyError extends Error {}

const sha1 = (s: string | Buffer): string => createHash('sha1').update(s).digest('hex').slice(0, 16);
const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const CAPTCHA_FRAME = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkoselabs|captcha/i;
const TRANSIENT = new Set(['intercepted', 'not-visible', 'detached', 'timeout', 'not-found', 'disabled']);
const BLOCKING = new Set(['intercepted', 'not-visible', 'disabled', 'detached', 'offscreen', 'not-found', 'ambiguous', 'timeout', 'invalid-target']);

/** Classify a Playwright error by the actionability check that failed. */
export function classifyError(err: unknown): { kind: string; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const first = msg.split('\n')[0] ?? msg;
  if (err instanceof TargetError) return { kind: 'invalid-target', message: first };
  if (/intercepts pointer events/.test(msg)) return { kind: 'intercepted', message: (msg.match(/(<[^\n]*?>[^\n]*?) intercepts pointer events/)?.[1] ?? first).slice(0, 300) };
  if (/strict mode violation/.test(msg)) return { kind: 'ambiguous', message: first };
  if (/element is not enabled|element is disabled|not editable/.test(msg)) return { kind: 'disabled', message: first };
  if (/outside of the viewport/.test(msg)) return { kind: 'offscreen', message: first };
  if (/element is not visible|not visible/.test(msg)) return { kind: 'not-visible', message: first };
  if (/not attached|detached/.test(msg)) return { kind: 'detached', message: first };
  if (/net::ERR_BLOCKED_BY_CLIENT/.test(msg)) return { kind: 'blocked-by-guard', message: first };
  if (/net::ERR_|NS_ERROR|Navigation failed/.test(msg)) return { kind: 'navigation', message: first };
  if (/Timeout \d+ms exceeded|timeout/i.test(msg)) return { kind: 'timeout', message: first };
  return { kind: 'error', message: first };
}

export function describeAction(a: OpAction): string {
  const t = (x?: Target): string => (x ? describeTarget(x) : 'page');
  switch (a.type) {
    case 'navigate':
      return `Navigate to ${a.url}`;
    case 'back':
    case 'forward':
    case 'reload':
      return a.type[0]!.toUpperCase() + a.type.slice(1);
    case 'click':
      return `Click ${t(a.target)}${a.button && a.button !== 'left' ? ` (${a.button})` : ''}`;
    case 'dblclick':
      return `Double-click ${t(a.target)}`;
    case 'hover':
      return `Hover ${t(a.target)}`;
    case 'focus':
      return `Focus ${t(a.target)}`;
    case 'fill':
      return `Fill ${t(a.target)} with ${a.value.includes('${env:') ? a.value : JSON.stringify(a.value)}`;
    case 'type':
      return `Type ${a.text.includes('${env:') ? a.text : JSON.stringify(a.text)} into ${t(a.target)}`;
    case 'press':
      return `Press ${a.key}${a.target ? ` in ${t(a.target)}` : ''}`;
    case 'clear':
      return `Clear ${t(a.target)}`;
    case 'select':
      return `Select ${a.value ?? a.label ?? `#${a.index}`} in ${t(a.target)}`;
    case 'check':
    case 'uncheck':
      return `${a.type === 'check' ? 'Check' : 'Uncheck'} ${t(a.target)}`;
    case 'scroll':
      return `Scroll ${a.to ?? `${a.direction ?? 'down'} ${a.amount ?? 600}px`}${a.target ? ` in ${t(a.target)}` : ''}`;
    case 'scrollIntoView':
      return `Scroll ${t(a.target)} into view`;
    case 'drag':
      return `Drag ${t(a.source)} onto ${t(a.target)}`;
    case 'upload':
      return `Upload ${a.files.map((f) => basename(f)).join(', ')} via ${t(a.target)}`;
    case 'switchTab':
      return `Switch to tab ${a.index ?? `matching /${a.urlMatches}/`}`;
    case 'closeTab':
      return `Close tab ${a.index ?? '(current)'}`;
    case 'wait':
      return `Wait ${a.ms}ms`;
  }
}

function primaryTarget(a: OpAction): Target | null {
  if (a.type === 'drag') return a.source;
  if ('target' in a && a.target) return a.target;
  return null;
}

/**
 * Browser control for one isolated, authorised session (one BrowserContext).
 * Every action is executed with real actionability checks (never `force`),
 * settled, observed and verified; its result is never "passed" without a
 * checked expected outcome.
 */
export class Operator {
  readonly redact = new Redactor();
  readonly recorder: EventRecorder;
  readonly results: ActionResult[] = [];
  readonly pages: Page[] = [];
  private current = 0;
  private openedAtSeq = new Map<Page, number>();
  private last: Observation | null = null;
  private ledger = new Map<string, { status: 'succeeded' | 'unknown' | 'failed-not-sent'; description: string }>();
  private halted: Challenge | null = null;
  private writeWindow: { seen: Set<string>; writes: number; duplicates: number } | null = null;
  private dialogPolicy: { accept: boolean; promptText?: string } | null = null;
  private counter = 0;
  private closed = false;

  private constructor(
    readonly context: BrowserContext,
    readonly config: RunConfigInfo,
    readonly opts: OperatorOptions,
  ) {
    const ev = opts.evidenceDir;
    this.recorder = new EventRecorder(this.redact, ev ? join(ev, 'events.jsonl') : null, ev ? join(ev, 'downloads') : null);
  }

  /** Open an isolated context (optionally with a role's saved session) and navigate to `url`. */
  static async open(
    browsers: BrowserManager,
    config: ConfigRequest,
    url: string,
    opts: OperatorOptions,
    storageState?: string,
  ): Promise<Operator> {
    const pol = checkUrl(url, opts.policy);
    if (!pol.ok) throw new PolicyError(pol.reason);
    if (opts.mode === 'approved-writes') {
      if (!opts.approval?.approvedBy) throw new PolicyError('Write mode requires an approval ({ approvedBy, reason }).');
      if (!pol.loopback && !opts.writeOrigins.includes(pol.url.origin)) {
        throw new PolicyError(`Writes are not authorised for ${pol.url.origin}. Add it to QA_MCP_WRITE_ORIGINS to allow approved writes there.`);
      }
    }
    if (opts.evidenceDir) mkdirSync(opts.evidenceDir, { recursive: true });
    const { context, info } = await browsers.newContext(config, { storageState });
    const op = new Operator(context, info, opts);
    await op.init();
    await op.act({ type: 'navigate', url: pol.url.href });
    return op;
  }

  private async init(): Promise<void> {
    await this.context.addInitScript({ content: loadObserverSource() });
    this.recorder.attachContext(this.context);
    await this.context.route('**/*', (route) => this.guard(route));
    if (this.opts.trace && this.opts.evidenceDir) {
      await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false, title: this.opts.sessionId });
    }
    this.context.on('page', (p) => this.addPage(p));
    this.addPage(await this.context.newPage());
  }

  private addPage(p: Page): void {
    if (this.pages.includes(p)) return;
    this.pages.push(p);
    this.openedAtSeq.set(p, this.recorder.lastSeq);
    this.recorder.attachPage(p, (d) => this.onDialog(d));
  }

  get page(): Page {
    const live = this.pages.filter((p) => !p.isClosed());
    const p = this.pages[this.current];
    return p && !p.isClosed() ? p : live[live.length - 1]!;
  }

  get observation(): Observation | null {
    return this.last;
  }

  get haltedBy(): Challenge | null {
    return this.halted;
  }

  /** Clear a halt after a human resolved the challenge (e.g. completed a manual login). */
  resume(): void {
    this.halted = null;
  }

  async observeNow(): Promise<Observation> {
    this.last = await observe(this.page, this.recorder);
    return this.last;
  }

  /** Resolve `${env:NAME}` references; resolved values are registered for redaction. */
  secret(v: string): string {
    return v.replace(ENV_REF, (_, name: string) => {
      const val = process.env[name];
      if (val === undefined) throw new PolicyError(`Environment variable ${name} is not set (referenced as \${env:${name}}).`);
      this.redact.add(val);
      return val;
    });
  }

  // ------------------------------------------------------------------ network guard
  private isReadOnlyRequest(req: Request): boolean {
    if (this.opts.readOnlyRequestPatterns.some((p) => new RegExp(p).test(req.url()))) return true;
    const ct = req.headers()['content-type'] ?? '';
    const body = req.postData() ?? '';
    return /json/.test(ct) && /"query"\s*:/.test(body) && !/\bmutation\b/.test(body);
  }

  private async guard(route: Route): Promise<void> {
    const req = route.request();
    const method = req.method().toUpperCase();
    let mainFrameNav = false;
    try {
      mainFrameNav = req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame();
    } catch {
      mainFrameNav = false;
    }
    if (mainFrameNav && /^https?:/.test(req.url()) && !checkUrl(req.url(), this.opts.policy).ok) {
      this.recorder.markBlocked(req, 'out-of-scope-navigation');
      return route.abort('blockedbyclient');
    }
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || this.isReadOnlyRequest(req) || this.opts.mode === 'login') {
      return route.fallback();
    }
    const w = this.writeWindow;
    if (w) {
      const key = `${method} ${req.url()} ${sha1(req.postDataBuffer() ?? '')}`;
      if (w.seen.has(key)) {
        w.duplicates++;
        this.recorder.markBlocked(req, 'duplicate-write');
        return route.abort('blockedbyclient');
      }
      w.seen.add(key);
      w.writes++;
      return route.fallback();
    }
    this.recorder.markBlocked(req, this.opts.mode === 'safe' ? 'safe-mode' : 'not-an-approved-write-action');
    return route.abort('blockedbyclient');
  }

  private async onDialog(d: Dialog): Promise<string> {
    const p = this.dialogPolicy;
    if (p?.accept) {
      await d.accept(p.promptText);
      return 'accepted';
    }
    if (d.type() === 'alert') {
      await d.accept();
      return 'acknowledged';
    }
    await d.dismiss();
    return 'dismissed';
  }

  // ------------------------------------------------------------------ evidence
  private async shot(name: string): Promise<{ path: string | null; png: PNG | null }> {
    if (!this.opts.screenshots || !this.opts.evidenceDir) return { path: null, png: null };
    try {
      const buf = await this.page.screenshot({ type: 'png', caret: 'hide', timeout: 5000 });
      const dir = join(this.opts.evidenceDir, 'actions');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${name}.png`);
      writeFileSync(path, buf);
      return { path, png: decode(buf) };
    } catch {
      return { path: null, png: null };
    }
  }

  // ------------------------------------------------------------------ helpers
  private uploadAllowed(file: string): { ok: boolean; path: string; reason?: string } {
    const abs = resolve(file);
    if (!existsSync(abs)) return { ok: false, path: abs, reason: `file does not exist: ${abs}` };
    const real = realpathSync(abs);
    const inside = this.opts.uploadRoots.some((root) => {
      if (!existsSync(root)) return false;
      const rel = relative(realpathSync(root), real);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    });
    return inside ? { ok: true, path: real } : { ok: false, path: real, reason: `uploads are only allowed from: ${this.opts.uploadRoots.join(', ') || '(none configured)'}` };
  }

  private async writeKey(a: OpAction, loc: Locator | null, info: TargetInfo | null): Promise<string> {
    const form = loc
      ? await loc
          .evaluate((el) => {
            const f = (el as HTMLButtonElement).form || el.closest('form');
            if (!f) return '';
            return Array.from(new FormData(f).entries())
              .map(([k, v]) => `${k}=${typeof v === 'string' ? v : (v as File).name}`)
              .join('&');
          })
          .catch(() => '')
      : '';
    // The concrete path (not the id-normalised route): deleting /projects/1 and /projects/2 are different writes.
    const here = (() => {
      try {
        return new URL(this.page.url()).pathname;
      } catch {
        return this.page.url();
      }
    })();
    return sha1(`${here}|${a.type}|${info?.role}:${info?.name}|${form}`);
  }

  private async resolveTarget(t: Target): Promise<{ loc: Locator | null; error: { kind: string; message: string } | null; candidates: string[] }> {
    let loc: Locator;
    try {
      loc = locate(this.page, t, this.last);
    } catch (err) {
      return { loc: null, error: classifyError(err), candidates: [] };
    }
    try {
      await loc.first().waitFor({ state: 'attached', timeout: this.opts.actionTimeoutMs });
    } catch {
      return { loc: null, error: { kind: 'not-found', message: `No element matches ${describeTarget(t)}` }, candidates: [] };
    }
    const n = await loc.count();
    if (n > 1 && t.nth === undefined) {
      const candidates = await loc.evaluateAll((els) =>
        els.slice(0, 5).map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${((el as HTMLElement).innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40)}"`),
      );
      return { loc: null, error: { kind: 'ambiguous', message: `${n} elements match ${describeTarget(t)}; add nth, within or a more specific name` }, candidates };
    }
    return { loc, error: null, candidates: [] };
  }

  private async interceptor(loc: Locator): Promise<string | null> {
    try {
      const h = (await loc.evaluate((el) => (window as any).__uqaObs?.hitInfo(el))) as { ok: boolean; hit: string | null } | null;
      return h && !h.ok ? h.hit : null;
    } catch {
      return null;
    }
  }

  private async execute(a: OpAction, loc: Locator | null, info: TargetInfo | null, files: string[]): Promise<void> {
    const t = this.opts.actionTimeoutMs;
    const page = this.page;
    switch (a.type) {
      case 'navigate':
        await page.goto(new URL(a.url, page.url() === 'about:blank' ? undefined : page.url()).href, { waitUntil: 'domcontentloaded', timeout: t * 4 });
        return;
      case 'back':
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: t * 2 });
        return;
      case 'forward':
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: t * 2 });
        return;
      case 'reload':
        await page.reload({ waitUntil: 'domcontentloaded', timeout: t * 4 });
        return;
      case 'click':
        await loc!.click({ button: a.button, modifiers: a.modifiers, timeout: t });
        return;
      case 'dblclick':
        await loc!.dblclick({ timeout: t });
        return;
      case 'hover':
        await loc!.hover({ timeout: t });
        return;
      case 'focus':
        await loc!.focus({ timeout: t });
        return;
      case 'fill':
        await loc!.fill(this.secret(a.value), { timeout: t });
        return;
      case 'type':
        if (loc) await loc.pressSequentially(this.secret(a.text), { delay: a.delayMs ?? 20, timeout: t });
        else await page.keyboard.type(this.secret(a.text), { delay: a.delayMs ?? 20 });
        return;
      case 'press':
        if (loc) await loc.press(a.key, { timeout: t });
        else await page.keyboard.press(a.key);
        return;
      case 'clear':
        await loc!.clear({ timeout: t });
        return;
      case 'select':
        await loc!.selectOption(a.value !== undefined ? { value: a.value } : a.label !== undefined ? { label: a.label } : { index: a.index ?? 0 }, { timeout: t });
        return;
      case 'check':
        await loc!.check({ timeout: t });
        return;
      case 'uncheck':
        await loc!.uncheck({ timeout: t });
        return;
      case 'scroll': {
        if (a.to) {
          const to = a.to;
          if (loc) await loc.evaluate((el, d) => el.scrollTo({ top: d === 'top' ? 0 : el.scrollHeight }), to);
          else await page.evaluate((d) => window.scrollTo(0, d === 'top' ? 0 : document.documentElement.scrollHeight), to);
          return;
        }
        const amount = a.amount ?? 600;
        const dir = a.direction ?? 'down';
        if (loc) await loc.hover({ timeout: t });
        else {
          const vp = page.viewportSize();
          if (vp) await page.mouse.move(vp.width / 2, vp.height / 2);
        }
        await page.mouse.wheel(dir === 'left' ? -amount : dir === 'right' ? amount : 0, dir === 'up' ? -amount : dir === 'down' ? amount : 0);
        return;
      }
      case 'scrollIntoView':
        await loc!.scrollIntoViewIfNeeded({ timeout: t });
        return;
      case 'drag': {
        const dst = await this.resolveTarget(a.target);
        if (!dst.loc) throw new TargetError(dst.error?.message ?? 'drop target not found');
        await loc!.dragTo(dst.loc, { timeout: t });
        return;
      }
      case 'upload':
        if (info?.isFileInput) await loc!.setInputFiles(files, { timeout: t });
        else {
          const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: t }), loc!.click({ timeout: t })]);
          await chooser.setFiles(files);
        }
        return;
      case 'switchTab': {
        const live = this.pages.filter((p) => !p.isClosed());
        const idx = a.index !== undefined ? a.index : live.findIndex((p) => new RegExp(a.urlMatches ?? '.').test(p.url()));
        const p = live[idx];
        if (!p) throw new TargetError(`No tab ${a.index ?? `matching /${a.urlMatches}/`} (${live.length} open)`);
        this.current = this.pages.indexOf(p);
        await p.bringToFront();
        return;
      }
      case 'closeTab': {
        const live = this.pages.filter((p) => !p.isClosed());
        if (live.length <= 1) throw new TargetError('Refusing to close the last tab');
        const p = a.index !== undefined ? live[a.index] : this.page;
        if (!p) throw new TargetError(`No tab ${a.index}`);
        await p.close();
        this.current = this.pages.indexOf(live.find((x) => x !== p)!);
        return;
      }
      case 'wait':
        await page.waitForTimeout(a.ms);
        return;
    }
  }

  private effects(before: Observation, after: Observation, fromSeq: number, settled: boolean, visual: number | null, visualPx: number | null, dupBlocked: number): ActionEffects {
    const events = this.recorder.since(fromSeq);
    const reqs = events.flatMap((e) => (e.kind === 'request' ? [e.record] : []));
    const appReqs = reqs.filter((r) => ['document', 'xhr', 'fetch', 'other', 'ping', 'eventsource'].includes(r.resourceType));
    const beforeOv = new Set(before.overlays.map((o) => `${o.role}:${o.name}`));
    const afterOv = new Set(after.overlays.map((o) => `${o.role}:${o.name}`));
    const beforeAlerts = new Set(before.alerts.map((a) => a.text));
    return {
      urlBefore: before.url,
      urlAfter: after.url,
      navigated: before.url !== after.url,
      fingerprintChanged: before.fingerprint !== after.fingerprint,
      textChanged: before.textHash !== after.textHash,
      visualChangeRatio: visual,
      visualChangedPixels: visualPx,
      overlaysOpened: [...afterOv].filter((x) => !beforeOv.has(x)),
      overlaysClosed: [...beforeOv].filter((x) => !afterOv.has(x)),
      alerts: after.alerts.map((a) => a.text).filter((t) => !beforeAlerts.has(t)),
      requests: appReqs.map((r) => ({ method: r.method, url: r.url, status: r.status, failure: r.failure, blockedByGuard: r.blockedByGuard })),
      writeRequests: appReqs.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method) && !r.blockedByGuard).length,
      duplicateWritesBlocked: dupBlocked,
      dialogs: events.flatMap((e) => (e.kind === 'dialog' ? [{ type: e.type, message: e.message, handled: e.handled }] : [])),
      popups: this.popupsSince(fromSeq).map((p) => this.redact.text(p.url())),
      downloads: events.flatMap((e) => (e.kind === 'download' ? [{ filename: e.filename, path: e.path }] : [])),
      // net::ERR_BLOCKED_BY_CLIENT is the browser reporting our own network guard; the blocked request is listed above.
      consoleErrors: events.flatMap((e) => (e.kind === 'console' && e.level === 'error' && !/ERR_BLOCKED_BY_CLIENT/.test(e.text) ? [e.text] : [])),
      pageErrors: events.flatMap((e) => (e.kind === 'pageerror' ? [e.text] : [])),
      settled,
    };
  }

  private popupsSince(seq: number): Page[] {
    return this.pages.filter((p) => (this.openedAtSeq.get(p) ?? 0) > seq && this.pages.indexOf(p) > 0);
  }

  private sessionExpiry(a: OpAction, before: Observation, after: Observation, fromSeq: number): string | null {
    if (!this.opts.role || this.opts.mode === 'login') return null;
    let origin = '';
    try {
      origin = new URL(before.url).origin;
    } catch {
      return null;
    }
    const r401 = this.recorder
      .since(fromSeq)
      .find((e) => e.kind === 'request' && e.record.status === 401 && e.record.url.startsWith(origin));
    if (r401 && r401.kind === 'request') return `${r401.record.method} ${r401.record.url} responded 401`;
    const lp = this.opts.loginUrlPattern ? new RegExp(this.opts.loginUrlPattern) : null;
    const explicitLogin = a.type === 'navigate' && lp?.test(a.url);
    if (lp && lp.test(after.url) && !lp.test(before.url) && !explicitLogin) return `redirected to the login page (${after.url})`;
    return null;
  }

  private sanitized(a: OpAction, info: TargetInfo | null): OpAction {
    if ((a.type === 'fill' || a.type === 'type') && info?.type === 'password') {
      const v = a.type === 'fill' ? a.value : a.text;
      if (!v.includes('${env:')) {
        this.redact.add(v);
        return a.type === 'fill' ? { ...a, value: '***' } : { ...a, text: '***' };
      }
    }
    return a;
  }

  // ------------------------------------------------------------------ act
  async act(action: OpAction, o: ActOptions = {}): Promise<ActionResult> {
    const seq = ++this.counter;
    const description = describeAction(action);
    const startSeq = this.recorder.lastSeq;
    const res: ActionResult = {
      seq,
      at: new Date().toISOString(),
      description,
      action,
      kind: 'read',
      classificationReason: '',
      status: 'failed',
      reason: '',
      attempts: [],
      expectations: [],
      effects: null,
      interceptedBy: null,
      challenge: null,
      evidence: { before: null, after: null, firstEventSeq: startSeq + 1, lastEventSeq: startSeq },
      observation: null,
      notes: [],
    };
    const finish = (status: ActionStatus, reason: string): ActionResult => {
      res.status = status;
      res.reason = this.redact.text(reason);
      res.evidence.lastEventSeq = this.recorder.lastSeq;
      res.notes = res.notes.map((n) => this.redact.text(n));
      this.results.push(res);
      this.recorder.action(status, `${description}: ${res.reason}`);
      return res;
    };

    if (this.closed) return finish('refused', 'session is closed');
    if (this.halted) {
      res.challenge = this.halted;
      return finish('needs-operator', `session halted: ${this.halted.reason} Operator intervention required before continuing.`);
    }

    // Resolve the target and read its semantics.
    const tgt = primaryTarget(action);
    let loc: Locator | null = null;
    let info: TargetInfo | null = null;
    if (tgt) {
      if (tgt.frame && CAPTCHA_FRAME.test(tgt.frame)) {
        return finish('refused', 'interacting with CAPTCHA / challenge frames is never automated; ask the operator');
      }
      const r = await this.resolveTarget(tgt);
      if (!r.loc) {
        res.attempts.push({ n: 1, startedAt: res.at, durationMs: 0, outcome: 'blocked', error: r.error });
        if (r.candidates.length) res.notes.push(`Candidates: ${r.candidates.join('; ')}`);
        return finish('blocked', `${r.error?.kind}: ${r.error?.message}`);
      }
      loc = r.loc;
      info = await targetInfo(loc, this.opts.actionTimeoutMs).catch(() => null);
    }
    res.action = this.sanitized(action, info);
    const cls = classifyAction(action, info);
    res.kind = cls.kind;
    res.classificationReason = cls.reason;

    // Policy checks before anything is executed.
    if (action.type === 'navigate') {
      const pol = checkUrl(new URL(action.url, this.page.url() === 'about:blank' ? undefined : this.page.url()).href, this.opts.policy);
      if (!pol.ok) return finish('refused', pol.reason);
    }
    let files: string[] = [];
    if (action.type === 'upload') {
      for (const f of action.files) {
        const chk = this.uploadAllowed(f);
        if (!chk.ok) return finish('refused', `upload refused: ${chk.reason}`);
        files.push(chk.path);
      }
    }
    const isWrite = cls.kind === 'write' || o.write === true;
    let ledgerKey: string | null = null;
    if (isWrite && this.opts.mode !== 'login') {
      if (cls.kind === 'write' && !o.write) {
        return finish('refused', `classified as a write (${cls.reason}) but not declared; set write: true in an approved-writes session to perform it`);
      }
      if (this.opts.mode !== 'approved-writes') {
        return finish('refused', `session is in safe mode; writes need an approved-writes session (${cls.reason})`);
      }
      ledgerKey = o.idempotencyKey ?? (await this.writeKey(action, loc, info));
      const prior = this.ledger.get(ledgerKey);
      if (prior && prior.status !== 'failed-not-sent' && !o.allowRepeat) {
        return finish('duplicate-prevented', `the same write was already performed in this session (${prior.status}): ${prior.description}`);
      }
    }

    const before = this.last ?? (await this.observeNow());
    const shotBefore = await this.shot(`${String(seq).padStart(3, '0')}-before`);
    res.evidence.before = shotBefore.path;

    const defaultRetries = cls.kind === 'read' ? 2 : 1;
    const maxAttempts = 1 + Math.min(3, o.retries ?? defaultRetries);
    let after: Observation = before;
    let lastError: { kind: string; message: string } | null = null;
    let attemptStartSeq = startSeq;
    let writesSent = 0;
    let dupBlocked = 0;
    let settled = true;
    let expectations: ExpectationResult[] = [];
    let reauthUsed = false;
    let unsettledDetail = '';

    for (let n = 1; n <= maxAttempts; n++) {
      const started = Date.now();
      attemptStartSeq = this.recorder.lastSeq;
      lastError = null;
      this.dialogPolicy = o.dialog ?? null;
      this.writeWindow = isWrite && this.opts.mode === 'approved-writes' ? { seen: new Set(), writes: 0, duplicates: 0 } : null;
      try {
        if (n > 1 && loc && tgt) {
          const r = await this.resolveTarget(tgt);
          if (r.loc) loc = r.loc;
        }
        await this.execute(action, loc, info, files);
      } catch (err) {
        lastError = classifyError(err);
        if (lastError.kind === 'intercepted' && loc) res.interceptedBy = (await this.interceptor(loc)) ?? lastError.message;
      }
      const s = await settle(this.page, this.recorder, {
        quietMs: this.opts.settleQuietMs,
        timeoutMs: this.opts.settleTimeoutMs,
      });
      settled = s.settled;
      if (!s.settled) unsettledDetail = `${s.pending.length ? `pending: ${s.pending.slice(0, 3).join(', ')}` : 'no pending requests'}; DOM ${s.mutating ? 'still mutating' : 'quiet at the end'}`;
      if (this.writeWindow) {
        writesSent += this.writeWindow.writes;
        dupBlocked += this.writeWindow.duplicates;
      }
      this.writeWindow = null;
      this.dialogPolicy = null;
      after = await this.observeNow().catch(() => before);

      // Challenges stop everything: a human must handle them.
      if (after.challenge) {
        res.challenge = after.challenge;
        if (after.challenge.kind !== 'auth' || !this.opts.role) {
          this.halted = after.challenge;
          res.attempts.push({ n, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, outcome: 'needs-operator', error: lastError });
          break;
        }
      }
      // Session expiry: re-authenticate if a scripted login exists and the retry is safe.
      const expired = this.sessionExpiry(action, before, after, attemptStartSeq) ?? (res.challenge?.kind === 'auth' ? res.challenge.reason : null);
      if (expired) {
        const safeToRepeat = cls.kind !== 'write' || writesSent === 0;
        if (this.opts.reauth && !reauthUsed && safeToRepeat) {
          reauthUsed = true;
          res.challenge = null;
          const ok = await this.opts.reauth(this).catch(() => false);
          res.notes.push(ok ? `Session expired (${expired}); re-authenticated with the role's scripted login.` : `Session expired (${expired}); scripted re-authentication failed.`);
          if (ok) {
            await this.page.goto(before.url, { waitUntil: 'domcontentloaded', timeout: this.opts.actionTimeoutMs * 4 }).catch(() => undefined);
            await settle(this.page, this.recorder, { quietMs: this.opts.settleQuietMs, timeoutMs: this.opts.settleTimeoutMs });
            res.attempts.push({ n, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, outcome: 'session-expired', error: lastError });
            n--; // the re-run after re-authentication does not consume a retry
            continue;
          }
        }
        res.challenge = { kind: 'session-expired', reason: `The session expired: ${expired}.`, evidence: expired };
        this.halted = res.challenge;
        res.attempts.push({ n, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, outcome: 'needs-operator', error: lastError });
        break;
      }

      if (!lastError) {
        const intrinsic = intrinsicExpectations(action, info, before.url).map((e) => ({ e, source: 'intrinsic' as const }));
        const explicit = (o.expect ?? []).map((e) => ({ e, source: 'explicit' as const }));
        expectations = await evaluateExpectations([...explicit, ...intrinsic], {
          page: this.page,
          recorder: this.recorder,
          sinceSeq: attemptStartSeq,
          before,
          last: this.last,
          observeNow: () => this.observeNow(),
          popupUrls: () => this.popupsSince(attemptStartSeq).map((p) => p.url()),
          secret: (v) => this.secret(v),
        }, o.expectTimeoutMs ?? this.opts.expectTimeoutMs);
        if (action.type === 'select' && loc && action.value === undefined) {
          const sel = await loc.evaluate((el) => {
            const s = el as HTMLSelectElement;
            return { index: s.selectedIndex, label: s.selectedOptions[0]?.label ?? '' };
          }).catch(() => null);
          const want = action.label !== undefined ? `label "${action.label}"` : `option #${action.index ?? 0}`;
          const ok = !!sel && (action.label !== undefined ? sel.label === action.label : sel.index === (action.index ?? 0));
          expectations.push({ description: `selected ${want}`, source: 'intrinsic', passed: ok, expected: want, actual: sel ? `#${sel.index} "${sel.label}"` : 'unreadable' });
        }
        if (action.type === 'upload' && loc && info?.isFileInput) {
          const names = await loc.evaluate((el) => Array.from((el as HTMLInputElement).files ?? []).map((f) => f.name)).catch(() => [] as string[]);
          const want = files.map((f) => basename(f));
          expectations.push({
            description: `file input holds ${want.join(', ')}`,
            source: 'intrinsic',
            passed: want.every((w) => names.includes(w)),
            expected: want.join(', '),
            actual: names.join(', ') || '(no files)',
          });
        }
      }
      const failedChecks = expectations.filter((x) => !x.passed);
      const outcome = lastError ? lastError.kind : failedChecks.length ? 'expectation-failed' : 'ok';
      res.attempts.push({ n, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, outcome, error: lastError });
      if (outcome === 'ok') break;

      // Bounded, safe retries only.
      const writeSafe = !isWrite || writesSent === 0;
      const attemptReqs = this.recorder.since(attemptStartSeq).flatMap((e) => (e.kind === 'request' && ['xhr', 'fetch', 'document'].includes(e.record.resourceType) ? [e.record] : []));
      // A non-toggle control whose attempt issued only GETs, some of which failed transiently, is safe to re-trigger.
      const transientRead =
        !isWrite && info?.expanded === null && info?.checked === null && attemptReqs.length > 0 &&
        attemptReqs.every((q) => ['GET', 'HEAD'].includes(q.method)) &&
        attemptReqs.some((q) => q.failure !== null || (q.status ?? 0) >= 500);
      const retryable =
        (lastError !== null && TRANSIENT.has(lastError.kind) && writeSafe) ||
        (lastError === null && failedChecks.length > 0 && !isWrite && (idempotentRead(action, info) || transientRead));
      if (!retryable || n === maxAttempts) break;
      res.notes.push(`Attempt ${n} ${outcome}; retrying (${n + 1}/${maxAttempts}).`);
      await this.page.waitForTimeout(300 * n);
    }

    const shotAfter = await this.shot(`${String(seq).padStart(3, '0')}-after`);
    res.evidence.after = shotAfter.path;
    const comparable = shotBefore.png && shotAfter.png && shotBefore.png.width === shotAfter.png.width && shotBefore.png.height === shotAfter.png.height;
    const visualPx = comparable ? diffCount(shotBefore.png!, shotAfter.png!, 24) : null;
    const visual = visualPx === null ? null : Math.round((visualPx / (shotBefore.png!.width * shotBefore.png!.height)) * 10_000) / 10_000;
    res.effects = this.effects(before, after, startSeq, settled, visual, visualPx, dupBlocked);
    res.expectations = expectations;
    res.observation = {
      url: after.url,
      title: after.title,
      fingerprint: after.fingerprint,
      controls: after.controls.length,
      overlays: after.overlays.map((x) => `${x.role}:${x.name}`),
      alerts: after.alerts.map((x) => x.text),
    };
    if (!settled) res.notes.push(`The UI did not settle within ${this.opts.settleTimeoutMs}ms (${unsettledDetail}).`);
    if (dupBlocked) res.notes.push(`${dupBlocked} identical write request(s) within this action were blocked as duplicates.`);
    const guardBlocked = res.effects.requests.filter((r) => r.blockedByGuard && r.blockedByGuard !== 'duplicate-write');
    if (guardBlocked.length) {
      res.notes.push(`Network guard blocked ${guardBlocked.length} request(s): ${guardBlocked.slice(0, 3).map((r) => `${r.method} ${r.url} (${r.blockedByGuard})`).join('; ')}`);
    }

    // Final status.
    const writeReqs = res.effects.requests.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method) && !r.blockedByGuard);
    const recordLedger = (status: 'succeeded' | 'unknown' | 'failed-not-sent'): void => {
      if (ledgerKey) this.ledger.set(ledgerKey, { status, description });
    };
    if (res.challenge) {
      recordLedger(writesSent ? 'unknown' : 'failed-not-sent');
      return finish('needs-operator', `${res.challenge.reason} Stopped; a human must resolve this (the operator never bypasses challenges).`);
    }
    if (lastError) {
      recordLedger(writesSent ? 'unknown' : 'failed-not-sent');
      if (BLOCKING.has(lastError.kind)) {
        return finish('blocked', `${lastError.kind}: ${lastError.message}${res.interceptedBy ? ` (intercepted by ${res.interceptedBy})` : ''}`);
      }
      return finish(writesSent ? 'outcome-unknown' : 'failed', `${lastError.kind}: ${lastError.message}`);
    }
    const failed = expectations.filter((x) => !x.passed);
    if (failed.length) {
      const sentButBroken = writeReqs.some((r) => r.failure !== null || (r.status !== null && r.status >= 500) || r.status === null);
      if (isWrite && writesSent > 0 && sentButBroken) {
        recordLedger('unknown');
        return finish('outcome-unknown', `write request sent but its outcome is unconfirmed (${writeReqs.map((r) => `${r.method} ${r.url} → ${r.failure ?? r.status ?? 'no response'}`).join('; ')}); not retried to avoid a duplicate submission`);
      }
      recordLedger(writesSent ? 'unknown' : 'failed-not-sent');
      return finish('failed', `expectation not met: ${failed.map((x) => `${x.description} (actual: ${x.actual})`).join('; ')}`);
    }
    if (expectations.length) {
      // Only a write that actually reached the server counts toward duplicate prevention.
      recordLedger(writesSent > 0 ? 'succeeded' : 'failed-not-sent');
      return finish('passed', `${expectations.length} expectation(s) verified`);
    }
    // No expected outcome available: report what changed, but never call it a success.
    recordLedger(writesSent ? 'unknown' : 'failed-not-sent');
    const e = res.effects;
    const changed =
      e.navigated || e.fingerprintChanged || e.textChanged || e.overlaysOpened.length || e.overlaysClosed.length || e.alerts.length ||
      e.requests.length || e.dialogs.length || e.popups.length || e.downloads.length || (e.visualChangedPixels ?? 0) >= 30;
    if (changed) return finish('performed', 'executed and an effect was observed, but no expected outcome was specified to verify');
    return finish('no-effect', 'executed but nothing observable changed (no navigation, DOM/visual change, request, dialog or popup)');
  }

  /** Copy cookies/localStorage from a saved storage state into this live context (re-authentication). */
  async applyStorageState(state: { cookies: Parameters<BrowserContext['addCookies']>[0]; origins: { origin: string; localStorage: { name: string; value: string }[] }[] }): Promise<void> {
    await this.context.clearCookies();
    await this.context.addCookies(state.cookies);
    const here = (() => {
      try {
        return new URL(this.page.url()).origin;
      } catch {
        return '';
      }
    })();
    for (const o of state.origins) {
      if (o.origin === here) {
        await this.page.evaluate((items) => items.forEach((i) => localStorage.setItem(i.name, i.value)), o.localStorage).catch(() => undefined);
      }
    }
  }

  writeLedger(): { key: string; status: string; description: string }[] {
    return [...this.ledger].map(([key, v]) => ({ key, ...v }));
  }

  /** Stop tracing, close the context and write the action log. */
  async close(): Promise<{ trace: string | null; eventLog: string | null; actionsLog: string | null }> {
    if (this.closed) return { trace: null, eventLog: null, actionsLog: null };
    this.closed = true;
    const dir = this.opts.evidenceDir;
    let trace: string | null = null;
    if (this.opts.trace && dir) {
      trace = join(dir, 'trace.zip');
      await this.context.tracing.stop({ path: trace }).catch(() => {
        trace = null;
      });
    }
    await this.context.close().catch(() => undefined);
    let actionsLog: string | null = null;
    if (dir) {
      actionsLog = join(dir, 'actions.json');
      writeFileSync(actionsLog, this.redact.text(JSON.stringify({ sessionId: this.opts.sessionId, role: this.opts.role, mode: this.opts.mode, approval: this.opts.approval, results: this.results, writes: this.writeLedger() }, null, 2)));
    }
    return { trace, eventLog: dir ? join(dir, 'events.jsonl') : null, actionsLog };
  }
}

export function writeAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.QA_MCP_WRITE_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function uploadRootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.QA_MCP_UPLOAD_DIRS ?? '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}
