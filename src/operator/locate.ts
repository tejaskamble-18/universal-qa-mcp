import type { FrameLocator, Locator, Page } from 'playwright';
import type { Observation, Target } from './types.js';

export class TargetError extends Error {}

type Scope = Page | FrameLocator | Locator;
type AriaRole = Parameters<Page['getByRole']>[0];

/** Human-readable description of a target for reports. */
export function describeTarget(t: Target): string {
  const parts: string[] = [];
  if (t.controlId) parts.push(`control ${t.controlId}`);
  if (t.role) parts.push(`${t.role}${t.name ? ` "${t.name}"` : ''}`);
  else if (t.name) parts.push(`"${t.name}"`);
  if (t.label) parts.push(`label "${t.label}"`);
  if (t.placeholder) parts.push(`placeholder "${t.placeholder}"`);
  if (t.text) parts.push(`text "${t.text}"`);
  if (t.testId) parts.push(`test id "${t.testId}"`);
  if (t.selector) parts.push(`\`${t.selector}\``);
  if (t.nth !== undefined) parts.push(`#${t.nth}`);
  if (t.within) parts.push(`in \`${t.within}\``);
  if (t.frame) parts.push(`in frame \`${t.frame}\``);
  return parts.join(' ') || '(empty target)';
}

/** Resolve a Target to a Playwright locator (not yet checked for existence or uniqueness). */
export function locate(page: Page, t: Target, last: Observation | null): Locator {
  let scope: Scope = t.frame ? page.frameLocator(t.frame) : page;
  if (t.within) scope = scope.locator(t.within);
  const s = scope as Locator;
  let loc: Locator;
  if (t.controlId) {
    const c = last?.controls.find((x) => x.ref === t.controlId);
    if (!c) throw new TargetError(`Control ${t.controlId} is not in the latest observation; observe again.`);
    loc = page.locator(c.selector);
  } else if (t.role) {
    loc = s.getByRole(t.role as AriaRole, t.name !== undefined ? { name: t.name, exact: t.exact ?? false } : {});
  } else if (t.label) {
    loc = s.getByLabel(t.label, { exact: t.exact ?? false });
  } else if (t.placeholder) {
    loc = s.getByPlaceholder(t.placeholder, { exact: t.exact ?? false });
  } else if (t.testId) {
    loc = s.getByTestId(t.testId);
  } else if (t.text) {
    loc = s.getByText(t.text, { exact: t.exact ?? false });
  } else if (t.selector) {
    loc = s.locator(t.selector);
  } else if (t.name) {
    loc = s.getByText(t.name, { exact: t.exact ?? false });
  } else {
    throw new TargetError('Target has no locator fields.');
  }
  return t.nth !== undefined ? loc.nth(t.nth) : loc;
}

export interface TargetInfo {
  tag: string;
  type: string | null;
  role: string;
  name: string;
  href: string | null;
  linkTarget: string | null;
  download: boolean;
  inForm: boolean;
  submit: boolean;
  haspopup: boolean;
  expanded: boolean | null;
  checked: boolean | null;
  selected: boolean | null;
  value: string | null;
  isFileInput: boolean;
  contentEditable: boolean;
}

/** Read the facts the classifier and intrinsic expectations need from a resolved element. */
export async function targetInfo(loc: Locator, timeout: number): Promise<TargetInfo> {
  return loc.evaluate((el) => {
    const e = el as unknown as { type?: string; checked?: boolean; value?: string; href?: string; form?: HTMLFormElement | null };
    const tag = el.tagName.toLowerCase();
    const explicitRole = el.getAttribute('role');
    const type = tag === 'input' ? (e.type ?? 'text') : tag === 'button' ? e.type || 'submit' : null;
    const implicit =
      tag === 'a' ? 'link' :
      tag === 'button' || tag === 'summary' ? 'button' :
      tag === 'select' ? 'combobox' :
      tag === 'textarea' ? 'textbox' :
      tag === 'input' ? (type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : /^(submit|button|reset|image)$/.test(type ?? '') ? 'button' : 'textbox') :
      'generic';
    const bool = (a: string): boolean | null => (el.hasAttribute(a) ? el.getAttribute(a) === 'true' : null);
    const label = el.getAttribute('aria-label') || (el as HTMLElement).innerText || e.value || el.getAttribute('title') || '';
    const submit =
      (tag === 'button' && !!e.form && (e.type || 'submit') === 'submit') ||
      (tag === 'input' && !!e.form && (e.type === 'submit' || e.type === 'image'));
    return {
      tag,
      type,
      role: explicitRole || implicit,
      name: label.replace(/\s+/g, ' ').trim().slice(0, 80),
      href: tag === 'a' ? e.href || null : null,
      linkTarget: el.getAttribute('target'),
      download: tag === 'a' && el.hasAttribute('download'),
      inForm: !!(e as unknown as { form?: HTMLFormElement }).form || !!el.closest('form'),
      submit,
      haspopup: !!el.getAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false',
      expanded: bool('aria-expanded'),
      checked: tag === 'input' && (e.type === 'checkbox' || e.type === 'radio') ? !!e.checked : bool('aria-checked'),
      selected: bool('aria-selected'),
      value: tag === 'input' || tag === 'select' || tag === 'textarea' ? (e.type === 'password' ? null : String(e.value)) : null,
      isFileInput: tag === 'input' && e.type === 'file',
      contentEditable: (el as HTMLElement).isContentEditable,
    };
  }, undefined, { timeout });
}
