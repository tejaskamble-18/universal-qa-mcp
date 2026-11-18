import type { TargetInfo } from './locate.js';
import type { ActionKind, OpAction } from './types.js';

/** Control labels that indicate a server-side change (or ending the session). */
export const WRITE_LABEL = new RegExp(
  '\\b(save|submit|create|update|delete|remove|destroy|send|post|publish|confirm|place order|pay|purchase|buy|checkout|' +
    'approve|reject|archive|restore|upload|apply|register|sign ?up|invite|import|reset|transfer|deploy|unsubscribe|' +
    'deactivate|sign ?out|log ?out)\\b',
  'i',
);

const DESTRUCTIVE_LINK = /\b(delete|remove|destroy|unsubscribe|deactivate|sign ?out|log ?out|cancel)\b/i;

/**
 * Classify what an action can change.
 * - read:  navigation, opening menus/tabs/disclosures, scrolling, hovering
 * - local: editing form fields, selecting files, dragging (client state until submitted)
 * - write: anything that submits or is labelled as a server-side change; switches
 *          (often persisted immediately) and sign-out (ends the session) count as writes
 * The network write guard backs this up: unapproved non-GET requests are aborted.
 */
export function classifyAction(a: OpAction, info: TargetInfo | null): { kind: ActionKind; reason: string } {
  switch (a.type) {
    case 'navigate':
    case 'back':
    case 'forward':
    case 'reload':
    case 'hover':
    case 'focus':
    case 'scroll':
    case 'scrollIntoView':
    case 'switchTab':
    case 'closeTab':
    case 'wait':
      return { kind: 'read', reason: `${a.type} does not submit data` };
    case 'fill':
    case 'type':
    case 'clear':
    case 'select':
    case 'drag':
    case 'upload':
      return { kind: 'local', reason: `${a.type} changes client-side state only (submission is a separate write)` };
    case 'check':
    case 'uncheck':
      if (info?.role === 'switch') return { kind: 'write', reason: 'switches commonly persist their state immediately' };
      return { kind: 'local', reason: `${a.type} changes a form control` };
    case 'press':
      if (/^(Enter|NumpadEnter)$/.test(a.key) && info?.inForm && info.tag !== 'textarea') {
        return { kind: 'write', reason: 'Enter inside a form field submits the form' };
      }
      return { kind: 'local', reason: 'key press' };
    case 'click':
    case 'dblclick': {
      if (!info) return { kind: 'read', reason: 'target unresolved' };
      if (info.submit) return { kind: 'write', reason: 'submit control of a form' };
      // A link navigates (GET); only destructive or session-ending link labels count as writes
      // ("Checkout" opens the checkout page, "Delete" or "Sign out" links may act on GET).
      if (info.href && !/^javascript:/i.test(info.href)) {
        if (DESTRUCTIVE_LINK.test(info.name)) return { kind: 'write', reason: `link "${info.name}" may change state on GET` };
        return { kind: 'read', reason: 'link navigation' };
      }
      if (WRITE_LABEL.test(info.name)) return { kind: 'write', reason: `label "${info.name}" indicates a server-side change` };
      if (info.role === 'switch') return { kind: 'write', reason: 'switches commonly persist their state immediately' };
      if (info.haspopup || info.expanded !== null) return { kind: 'read', reason: 'opens/closes a menu or disclosure' };
      if (info.role === 'tab' || info.role === 'menuitem' || info.role === 'option') return { kind: 'read', reason: `${info.role} selection` };
      if (info.role === 'checkbox' || info.role === 'radio') return { kind: 'local', reason: 'toggles a form control' };
      return { kind: 'read', reason: 'no write signal on the control (network guard still applies)' };
    }
  }
}

/** Actions that can be repeated without changing the outcome, so retrying them after a failed check is safe. */
export function idempotentRead(a: OpAction, info: TargetInfo | null): boolean {
  if (a.type === 'navigate' || a.type === 'reload' || a.type === 'scrollIntoView' || a.type === 'wait' || a.type === 'switchTab') return true;
  if ((a.type === 'click' || a.type === 'hover') && info) {
    if (info.href && !info.href.includes('#')) return true;
    if (info.role === 'tab') return true;
    if (a.type === 'hover') return true;
  }
  return false;
}
