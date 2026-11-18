import { classifyAction } from '../operator/classify.js';
import type { TargetInfo } from '../operator/locate.js';
import { normalizeRoute } from '../operator/observe.js';
import type { ActionKind, Observation, ObservedControl, OpAction } from '../operator/types.js';

export type CandidateStatus =
  | 'untested'
  | 'tested'
  | 'skipped-unsafe'
  | 'skipped-out-of-scope'
  | 'skipped-similar'
  | 'skipped-depth'
  | 'skipped-budget'
  | 'unreachable'
  | 'halted';

export interface Candidate {
  key: string;
  /** Identity across states: the same control (or link destination) seen on another page. */
  globalKey: string;
  description: string;
  kind: ActionKind;
  priority: number;
  actions: OpAction[];
  status: CandidateStatus;
  reason: string;
}

export interface Scope {
  origin: string;
  pathPrefix: string;
}

const FIELD_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox', 'slider']);

function infoOf(c: ObservedControl): TargetInfo {
  return {
    tag: c.tag,
    type: c.type,
    role: c.role,
    name: c.name,
    href: c.href,
    linkTarget: c.target,
    download: false,
    inForm: c.form >= 0,
    submit: c.submit,
    haspopup: !!c.state.haspopup,
    expanded: c.state.expanded ?? null,
    checked: c.state.checked ?? null,
    selected: c.state.selected ?? null,
    value: null,
    isFileInput: c.tag === 'input' && c.type === 'file',
    contentEditable: false,
  };
}

function inScope(href: string, scope: Scope): boolean {
  try {
    const u = new URL(href);
    return u.origin === scope.origin && u.pathname.startsWith(scope.pathPrefix);
  } catch {
    return false;
  }
}

/** A value that satisfies common constraints for a field, used to exercise dynamic forms without submitting. */
function sampleFill(c: ObservedControl): OpAction | null {
  const target = { selector: c.selector };
  if (c.tag === 'select') return { type: 'select', target, index: 1 };
  if (c.role === 'checkbox') return c.state.checked ? null : { type: 'check', target };
  if (c.role === 'radio') return null;
  if (c.tag !== 'input' && c.tag !== 'textarea') return null;
  switch (c.type) {
    case 'password':
    case 'file':
    case 'hidden':
    case 'submit':
    case 'button':
    case 'reset':
    case 'image':
      return null;
    case 'email':
      return { type: 'fill', target, value: 'qa.explorer@example.com' };
    case 'number':
    case 'range':
      return { type: 'fill', target, value: '1' };
    case 'tel':
      return { type: 'fill', target, value: '+15555550100' };
    case 'url':
      return { type: 'fill', target, value: 'https://example.com/' };
    case 'date':
      return { type: 'fill', target, value: '2030-01-15' };
    case 'search':
      return { type: 'fill', target, value: 'qa' };
    default:
      return { type: 'fill', target, value: 'QA exploration' };
  }
}

/**
 * Propose actions from a live observation. Writes are never proposed in
 * exploration (recorded as skipped-unsafe); repetitive items are sampled;
 * form fields are exercised together with valid sample values but never submitted.
 */
export function plan(stateId: string, obs: Observation, scope: Scope, sampleSimilar: number): Candidate[] {
  const out: Candidate[] = [];
  const similar = new Map<string, number>();
  const occurrences = new Map<string, number>();
  const label = (c: ObservedControl): string => `${c.role} "${c.name || c.selector}"`;
  for (const c of obs.controls) {
    if (!c.enabled) continue;
    if (FIELD_ROLES.has(c.role) || (c.role === 'checkbox' && c.form >= 0) || (c.role === 'radio' && c.form >= 0)) continue; // via form strategy
    const occ = (occurrences.get(c.signature) ?? 0) + 1;
    occurrences.set(c.signature, occ);
    const key = `${stateId}|${c.signature}|${occ}`;
    const action: OpAction = { type: 'click', target: { selector: c.selector } };
    const globalKey = c.href ? `link:${normalizeRoute(c.href)}` : `sig:${c.signature}`;
    const base = { key, globalKey, description: `Click ${label(c)}`, actions: [action], priority: 50 };
    const cls = classifyAction(action, infoOf(c));
    if (c.tag === 'input' && c.type === 'file') {
      out.push({ ...base, kind: 'local', status: 'skipped-unsafe', reason: 'file selection needs an explicit upload action with an allowed file' });
      continue;
    }
    if (c.state.draggable && c.role === 'generic') {
      out.push({ ...base, kind: 'local', status: 'skipped-unsafe', reason: 'drag-only element; drag interactions need an explicit drag action with a drop target' });
      continue;
    }
    if (c.href) {
      if (/^(mailto|tel|sms|javascript):/i.test(c.href)) {
        out.push({ ...base, kind: 'read', status: 'skipped-out-of-scope', reason: 'non-HTTP link scheme' });
        continue;
      }
      if (!inScope(c.href, scope)) {
        out.push({ ...base, kind: 'read', status: 'skipped-out-of-scope', reason: `outside the authorised scope (${scope.origin}${scope.pathPrefix})` });
        continue;
      }
    }
    if (cls.kind === 'write') {
      out.push({ ...base, kind: 'write', status: 'skipped-unsafe', reason: `write action (${cls.reason}); exploration is read-only` });
      continue;
    }
    if (c.role === 'checkbox' || c.role === 'radio' || c.role === 'switch') {
      out.push({ ...base, kind: cls.kind, status: 'skipped-unsafe', reason: 'stand-alone toggle may persist state; not toggled during exploration' });
      continue;
    }
    const simKey = globalKey;
    const seen = (similar.get(simKey) ?? 0) + 1;
    similar.set(simKey, seen);
    if (seen > sampleSimilar) {
      out.push({ ...base, kind: cls.kind, status: 'skipped-similar', reason: `similar to ${sampleSimilar} already-planned action(s) (${simKey})` });
      continue;
    }
    let priority = 50;
    if (c.overlay >= 0) priority = 100;
    else if (c.role === 'tab') priority = 90;
    else if (c.state.haspopup || c.state.expanded === false) priority = 80;
    else if (c.href) priority = 60;
    out.push({ ...base, kind: cls.kind, priority, status: 'untested', reason: cls.reason });
  }
  for (const f of obs.forms) {
    const fields = f.fields.map((ref) => obs.controls.find((c) => c.ref === ref)).filter((c): c is ObservedControl => !!c && c.enabled);
    const actions = fields.map(sampleFill).filter((a): a is OpAction => !!a);
    if (!actions.length) continue;
    out.push({
      key: `${stateId}|form:${f.selector}`,
      globalKey: `form:${normalizeRoute(obs.url)}|${fields.map((x) => x.signature).sort().join(',')}`,
      description: `Fill form ${f.selector} with sample values (${actions.length} field(s), not submitted)`,
      kind: 'local',
      priority: 40,
      actions,
      status: 'untested',
      reason: 'exercises dynamic form behaviour without submitting',
    });
  }
  return out;
}
