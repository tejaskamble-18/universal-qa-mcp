import type { Page } from 'playwright';
import type { EventRecorder, OpEvent } from '../operator/events.js';
import { describeTarget, locate, type TargetInfo } from '../operator/locate.js';
import type { Expectation, ExpectationResult, Observation, OpAction, Target } from '../operator/types.js';

export interface ExpectContext {
  page: Page;
  recorder: EventRecorder;
  /** Only events after this sequence number belong to the action being verified. */
  sinceSeq: number;
  before: Observation | null;
  last: Observation | null;
  observeNow: () => Promise<Observation>;
  /** URLs of pages opened as popups during the action. */
  popupUrls: () => string[];
  /** Resolve `${env:NAME}` references (for value comparisons). */
  secret: (v: string) => string;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function describeExpectation(e: Expectation): string {
  switch (e.type) {
    case 'url':
      return `URL matches /${e.matches}/`;
    case 'visible':
      return `${describeTarget(e.target)} is visible`;
    case 'hidden':
      return `${describeTarget(e.target)} is not visible`;
    case 'text':
      return `page${e.within ? ` region \`${e.within}\`` : ''} shows "${e.contains}"`;
    case 'notText':
      return `page${e.within ? ` region \`${e.within}\`` : ''} does not show "${e.contains}"`;
    case 'count':
      return `${describeTarget(e.target)} count ${e.equals !== undefined ? `= ${e.equals}` : `in [${e.min ?? 0}, ${e.max ?? '∞'}]`}`;
    case 'state':
      return `${describeTarget(e.target)} state ${JSON.stringify({ checked: e.checked, expanded: e.expanded, selected: e.selected, disabled: e.disabled, value: e.value && e.value.startsWith('${env:') ? '***' : e.value })}`;
    case 'request':
      return `${e.method ?? 'any'} request to /${e.url}/${e.status !== undefined ? ` with status ${e.status}` : ''}${e.count !== undefined ? ` × ${e.count}` : ''}`;
    case 'noRequest':
      return `no ${e.method ?? ''} request to /${e.url}/`.replace('  ', ' ');
    case 'dialog':
      return `${e.kind ?? 'a'} dialog${e.messageContains ? ` containing "${e.messageContains}"` : ''} was shown`;
    case 'popup':
      return `a popup opened${e.urlMatches ? ` at /${e.urlMatches}/` : ''}`;
    case 'download':
      return `a download started${e.filenameMatches ? ` named /${e.filenameMatches}/` : ''}`;
    case 'alert':
      return `a live-region message contains "${e.contains}"`;
    case 'noConsoleErrors':
      return 'no console errors or page errors';
    case 'stateChanged':
      return 'the UI state changed';
  }
}

async function readState(page: Page, t: Target, last: Observation | null) {
  const loc = locate(page, t, last);
  const n = await loc.count();
  if (n === 0) return null;
  return loc.first().evaluate((el) => {
    const e = el as unknown as { type?: string; checked?: boolean; value?: string; disabled?: boolean };
    const attr = (a: string): boolean | undefined => (el.hasAttribute(a) ? el.getAttribute(a) === 'true' : undefined);
    const isBox = el.tagName === 'INPUT' && (e.type === 'checkbox' || e.type === 'radio');
    return {
      checked: isBox ? e.checked : attr('aria-checked'),
      expanded: attr('aria-expanded'),
      selected: el.tagName === 'OPTION' ? (el as HTMLOptionElement).selected : attr('aria-selected'),
      disabled: !!(e as { disabled?: boolean }).disabled || el.getAttribute('aria-disabled') === 'true',
      value: 'value' in e ? String(e.value) : (el.textContent ?? '').trim(),
      password: el.tagName === 'INPUT' && e.type === 'password',
    };
  });
}

function eventsOf<K extends OpEvent['kind']>(ctx: ExpectContext, kind: K): Extract<OpEvent, { kind: K }>[] {
  return ctx.recorder.since(ctx.sinceSeq).filter((e): e is Extract<OpEvent, { kind: K }> => e.kind === kind);
}

async function checkOnce(e: Expectation, ctx: ExpectContext): Promise<{ passed: boolean; actual: string }> {
  const { page } = ctx;
  switch (e.type) {
    case 'url': {
      const u = page.url();
      return { passed: new RegExp(e.matches).test(u), actual: u };
    }
    case 'visible':
    case 'hidden': {
      const loc = locate(page, e.target, ctx.last);
      const visible = await loc.filter({ visible: true }).count();
      const total = await loc.count();
      const passed = e.type === 'visible' ? visible > 0 : visible === 0;
      return { passed, actual: `${visible} visible of ${total} matching` };
    }
    case 'text':
    case 'notText': {
      const text = await page.locator(e.within ?? 'body').first().innerText({ timeout: 2000 }).catch(() => '');
      const has = text.includes(e.contains);
      return { passed: e.type === 'text' ? has : !has, actual: has ? `found "${e.contains}"` : `"${e.contains}" not in ${text.length} chars of visible text` };
    }
    case 'count': {
      const n = await locate(page, e.target, ctx.last).filter({ visible: true }).count();
      const ok = (e.equals === undefined || n === e.equals) && (e.min === undefined || n >= e.min) && (e.max === undefined || n <= e.max);
      return { passed: ok, actual: `${n} visible` };
    }
    case 'state': {
      const s = await readState(page, e.target, ctx.last);
      if (!s) return { passed: false, actual: 'element not found' };
      const want: Record<string, unknown> = {};
      if (e.checked !== undefined) want.checked = e.checked;
      if (e.expanded !== undefined) want.expanded = e.expanded;
      if (e.selected !== undefined) want.selected = e.selected;
      if (e.disabled !== undefined) want.disabled = e.disabled;
      if (e.value !== undefined) want.value = ctx.secret(e.value);
      const got: Record<string, unknown> = { checked: s.checked, expanded: s.expanded, selected: s.selected, disabled: s.disabled, value: s.value };
      const passed = Object.entries(want).every(([k, v]) => got[k] === v);
      const shown = Object.fromEntries(Object.keys(want).map((k) => [k, k === 'value' && (s.password || e.value?.startsWith('${env:')) ? (passed ? '***(match)' : '***(mismatch)') : got[k]]));
      return { passed, actual: JSON.stringify(shown) };
    }
    case 'request':
    case 'noRequest': {
      const re = new RegExp(e.url);
      const hits = eventsOf(ctx, 'request')
        .map((x) => x.record)
        .filter((r) => re.test(r.url) && (!e.method || r.method.toUpperCase() === e.method.toUpperCase()));
      if (e.type === 'noRequest') return { passed: hits.length === 0, actual: `${hits.length} matching request(s)` };
      const st = e.status;
      const good = hits.filter((r) => {
        if (st === undefined) return true;
        if (st === 'success') return r.status !== null && r.status >= 200 && r.status < 400;
        if (st === 'failure') return r.failure !== null || (r.status !== null && r.status >= 400);
        return r.status === st;
      });
      const passed = e.count !== undefined ? good.length === e.count : good.length > 0;
      return {
        passed,
        actual: hits.length ? hits.map((r) => `${r.method} ${r.url} → ${r.failure ?? r.status ?? 'pending'}${r.blockedByGuard ? ` (blocked: ${r.blockedByGuard})` : ''}`).join('; ') : 'no matching request',
      };
    }
    case 'dialog': {
      const d = eventsOf(ctx, 'dialog').filter((x) => (!e.kind || x.type === e.kind) && (!e.messageContains || x.message.includes(e.messageContains)));
      return { passed: d.length > 0, actual: d.length ? d.map((x) => `${x.type}: ${x.message} (${x.handled})`).join('; ') : 'no dialog' };
    }
    case 'popup': {
      const urls = ctx.popupUrls();
      const ok = urls.some((u) => !e.urlMatches || new RegExp(e.urlMatches).test(u));
      return { passed: ok, actual: urls.length ? urls.join(', ') : 'no popup' };
    }
    case 'download': {
      const d = eventsOf(ctx, 'download').filter((x) => !e.filenameMatches || new RegExp(e.filenameMatches).test(x.filename));
      return { passed: d.length > 0, actual: d.length ? d.map((x) => x.filename).join(', ') : 'no download' };
    }
    case 'alert': {
      const texts = await page
        .locator('[role="alert"],[role="status"],[aria-live]')
        .filter({ visible: true })
        .allInnerTexts()
        .catch(() => [] as string[]);
      const hit = texts.find((t) => t.includes(e.contains));
      return { passed: !!hit, actual: texts.length ? texts.map((t) => t.trim().slice(0, 100)).join(' | ') : 'no live-region text' };
    }
    case 'noConsoleErrors': {
      const errs = [...eventsOf(ctx, 'console').filter((c) => c.level === 'error' && !/ERR_BLOCKED_BY_CLIENT/.test(c.text)).map((c) => c.text), ...eventsOf(ctx, 'pageerror').map((p) => p.text)];
      return { passed: errs.length === 0, actual: errs.length ? errs.slice(0, 3).join(' | ') : 'none' };
    }
    case 'stateChanged': {
      const now = await ctx.observeNow();
      const b = ctx.before;
      const changed = !b || now.fingerprint !== b.fingerprint || now.textHash !== b.textHash || now.url !== b.url;
      return { passed: changed, actual: changed ? `fingerprint ${b?.fingerprint} → ${now.fingerprint}` : 'unchanged' };
    }
  }
}

/** Evaluate expectations, polling DOM/event conditions until all pass or the timeout elapses. */
export async function evaluateExpectations(
  list: { e: Expectation; source: 'explicit' | 'intrinsic' }[],
  ctx: ExpectContext,
  timeoutMs: number,
): Promise<ExpectationResult[]> {
  const deadline = Date.now() + timeoutMs;
  const results = new Map<number, { passed: boolean; actual: string }>();
  for (;;) {
    for (const [k, item] of list.entries()) {
      if (results.get(k)?.passed) continue;
      try {
        results.set(k, await checkOnce(item.e, ctx));
      } catch (err) {
        results.set(k, { passed: false, actual: `could not evaluate: ${(err as Error).message.split('\n')[0]}` });
      }
    }
    const allPassed = list.every((_, k) => results.get(k)?.passed);
    if (allPassed || Date.now() >= deadline) break;
    await ctx.page.waitForTimeout(100);
  }
  return list.map((item, k) => ({
    description: describeExpectation(item.e),
    source: item.source,
    passed: results.get(k)?.passed ?? false,
    expected: describeExpectation(item.e),
    actual: results.get(k)?.actual ?? 'not evaluated',
  }));
}

/**
 * Outcomes implied by the control's own semantics, so common actions are
 * verified even without caller-supplied expectations.
 */
export function intrinsicExpectations(a: OpAction, info: TargetInfo | null, pageUrl: string): Expectation[] {
  const t = 'target' in a && a.target && a.type !== 'drag' ? a.target : null;
  switch (a.type) {
    case 'navigate': {
      const target = new URL(a.url, pageUrl);
      return [{ type: 'url', matches: `^${esc(`${target.origin}${target.pathname}`)}` }];
    }
    case 'fill':
      return t && !info?.contentEditable ? [{ type: 'state', target: t, value: a.value }] : [];
    case 'clear':
      return t ? [{ type: 'state', target: t, value: '' }] : [];
    case 'select':
      return t && a.value !== undefined ? [{ type: 'state', target: t, value: a.value }] : [];
    case 'check':
      return t ? [{ type: 'state', target: t, checked: true }] : [];
    case 'uncheck':
      return t ? [{ type: 'state', target: t, checked: false }] : [];
    case 'click': {
      if (!t || !info) return [];
      if (info.role === 'tab') return [{ type: 'state', target: t, selected: true }];
      if (info.expanded !== null && !info.href) return [{ type: 'state', target: t, expanded: !info.expanded }];
      if (info.role === 'checkbox' || info.role === 'switch') return info.checked === null ? [] : [{ type: 'state', target: t, checked: !info.checked }];
      if (info.role === 'radio') return [{ type: 'state', target: t, checked: true }];
      if (info.href && info.download) return [{ type: 'download' }];
      if (info.href && info.linkTarget === '_blank') return [{ type: 'popup' }];
      if (info.href) {
        const href = new URL(info.href, pageUrl);
        const samePageAnchor = href.origin + href.pathname === new URL(pageUrl).origin + new URL(pageUrl).pathname && href.hash;
        if (samePageAnchor || /^javascript:/i.test(info.href)) return [];
        return [{ type: 'url', matches: `^${esc(`${href.origin}${href.pathname}`)}` }];
      }
      return [];
    }
    default:
      return [];
  }
}
