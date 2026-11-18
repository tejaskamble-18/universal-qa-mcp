import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserContext, Download, Page, Request } from 'playwright';
import type { RequestRecord } from './types.js';

export type OpEvent =
  | { seq: number; at: string; kind: 'request'; record: RequestRecord }
  | { seq: number; at: string; kind: 'console'; level: string; text: string; page: number }
  | { seq: number; at: string; kind: 'pageerror'; text: string; page: number }
  | { seq: number; at: string; kind: 'dialog'; type: string; message: string; handled: string; page: number }
  | { seq: number; at: string; kind: 'popup'; url: string; page: number }
  | { seq: number; at: string; kind: 'navigation'; url: string; page: number }
  | { seq: number; at: string; kind: 'download'; filename: string; path: string | null; page: number }
  | { seq: number; at: string; kind: 'action'; status: string; description: string }
  | { seq: number; at: string; kind: 'note'; text: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const SENSITIVE_QUERY = /([?&](?:token|access_token|id_token|password|passwd|secret|key|code|sig|signature|session)=)[^&#]*/gi;

/** Redacts secret values and sensitive query parameters before anything is logged. */
export class Redactor {
  private secrets = new Set<string>();
  add(value: string): void {
    if (value && value.length >= 3) this.secrets.add(value);
  }
  text(s: string): string {
    let out = s.replace(SENSITIVE_QUERY, '$1***');
    for (const v of this.secrets) out = out.split(v).join('***');
    return out;
  }
}

/**
 * Records page-level events for one browser context with monotonic sequence
 * numbers, tracks in-flight requests for settling, and appends a JSONL event log.
 */
export class EventRecorder {
  private seq = 0;
  readonly events: OpEvent[] = [];
  private inflight = new Map<Request, { seq: number; started: number; page: number }>();
  private pages: Page[] = [];
  private requestRecords = new Map<Request, RequestRecord>();

  constructor(
    private readonly redact: Redactor,
    private readonly logPath: string | null,
    private readonly downloadDir: string | null,
  ) {
    if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  }

  get lastSeq(): number {
    return this.seq;
  }

  pageIndex(p: Page): number {
    let i = this.pages.indexOf(p);
    if (i < 0) {
      this.pages.push(p);
      i = this.pages.length - 1;
    }
    return i;
  }

  private push(e: DistributiveOmit<OpEvent, 'seq' | 'at'>): OpEvent {
    const ev = { ...e, seq: ++this.seq, at: new Date().toISOString() } as OpEvent;
    this.events.push(ev);
    if (this.logPath) appendFileSync(this.logPath, `${JSON.stringify(ev)}\n`);
    return ev;
  }

  note(text: string): void {
    this.push({ kind: 'note', text: this.redact.text(text) });
  }

  action(status: string, description: string): void {
    this.push({ kind: 'action', status, description: this.redact.text(description) });
  }

  /** Mark a request blocked by the network write guard (called from the route handler). */
  markBlocked(req: Request, reason: string): void {
    const rec = this.requestRecords.get(req);
    if (rec) rec.blockedByGuard = reason;
    else this.pendingBlocks.set(req, reason);
  }
  private pendingBlocks = new Map<Request, string>();

  attachContext(context: BrowserContext): void {
    context.on('request', (req) => {
      let pi = -1;
      try {
        pi = this.pageIndex(req.frame().page());
      } catch {
        // Popup navigation requests are issued before their frame exists.
      }
      const record: RequestRecord = {
        seq: 0,
        method: req.method(),
        url: this.redact.text(req.url()),
        resourceType: req.resourceType(),
        status: null,
        failure: null,
        blockedByGuard: this.pendingBlocks.get(req) ?? null,
        page: pi,
      };
      this.requestRecords.set(req, record);
      const ev = this.push({ kind: 'request', record });
      record.seq = ev.seq;
      if (req.resourceType() !== 'eventsource' && req.resourceType() !== 'websocket') {
        this.inflight.set(req, { seq: ev.seq, started: Date.now(), page: pi });
      }
    });
    context.on('requestfinished', async (req) => {
      this.inflight.delete(req);
      const rec = this.requestRecords.get(req);
      if (rec) rec.status = (await req.response().catch(() => null))?.status() ?? null;
    });
    context.on('requestfailed', (req) => {
      this.inflight.delete(req);
      const rec = this.requestRecords.get(req);
      if (rec) {
        rec.failure = req.failure()?.errorText ?? 'failed';
        if (!rec.blockedByGuard && this.pendingBlocks.has(req)) rec.blockedByGuard = this.pendingBlocks.get(req)!;
      }
    });
    context.on('response', (resp) => {
      const rec = this.requestRecords.get(resp.request());
      if (rec) rec.status = resp.status();
      // Apps often never read a response body (e.g. `if (r.ok) navigate()`), so Chromium never reports the
      // request finished. Once a response has arrived it no longer blocks settling; DOM quiet covers the rest.
      this.inflight.delete(resp.request());
    });
  }

  attachPage(page: Page, onDialog: (d: import('playwright').Dialog) => Promise<string>): void {
    const pi = this.pageIndex(page);
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') this.push({ kind: 'console', level: m.type(), text: this.redact.text(m.text().slice(0, 500)), page: pi });
    });
    page.on('pageerror', (e) => this.push({ kind: 'pageerror', text: this.redact.text(e.message.slice(0, 500)), page: pi }));
    page.on('dialog', async (d) => {
      const handled = await onDialog(d).catch((err) => `error: ${(err as Error).message}`);
      this.push({ kind: 'dialog', type: d.type(), message: this.redact.text(d.message().slice(0, 300)), handled, page: pi });
    });
    page.on('popup', (p) => this.push({ kind: 'popup', url: this.redact.text(p.url()), page: pi }));
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) this.push({ kind: 'navigation', url: this.redact.text(f.url()), page: pi });
    });
    page.on('download', (d: Download) => {
      // Record immediately (so the triggering action sees it); the saved path is filled in once written.
      const ev = this.push({ kind: 'download', filename: d.suggestedFilename(), path: null, page: pi }) as Extract<OpEvent, { kind: 'download' }>;
      if (!this.downloadDir) return;
      mkdirSync(this.downloadDir, { recursive: true });
      const path = `${this.downloadDir}/${Date.now()}-${d.suggestedFilename().replace(/[^\w.-]+/g, '_')}`;
      d.saveAs(path).then(
        () => {
          ev.path = path;
        },
        () => undefined,
      );
    });
  }

  /** Requests still in flight (excluding long-lived streams and requests older than `staleMs`). */
  pending(staleMs = 10_000): string[] {
    const now = Date.now();
    return [...this.inflight.entries()].filter(([, v]) => now - v.started < staleMs).map(([r]) => `${r.method()} ${this.redact.text(r.url())}`);
  }

  since(seq: number): OpEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }
}
