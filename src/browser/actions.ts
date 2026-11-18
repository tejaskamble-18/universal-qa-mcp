import type { Page } from 'playwright';
import * as z from 'zod';

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), selector: z.string() }),
  z.object({ type: z.literal('hover'), selector: z.string() }),
  z.object({ type: z.literal('focus'), selector: z.string() }),
  z.object({ type: z.literal('press'), key: z.string(), selector: z.string().optional() }),
  z.object({ type: z.literal('fill'), selector: z.string(), value: z.string() }),
  z.object({ type: z.literal('select'), selector: z.string(), value: z.string() }),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(30_000) }),
  z.object({ type: z.literal('waitFor'), selector: z.string(), state: z.enum(['attached', 'visible', 'hidden']).optional() }),
]);
export type Action = z.infer<typeof ActionSchema>;

/** Labels that suggest an irreversible or outward-facing action. */
export const DESTRUCTIVE = new RegExp(
  '\\b(delete|remove|destroy|erase|purge|drop|terminate|unsubscribe|deactivate|close account|' +
    'pay|purchase|buy|checkout|place order|submit order|transfer|send money|confirm payment|publish|deploy)\\b',
  'i',
);

export class ActionPolicyError extends Error {}

export function describeAction(a: Action): string {
  switch (a.type) {
    case 'click':
    case 'hover':
    case 'focus':
      return `${a.type[0]!.toUpperCase()}${a.type.slice(1)} \`${a.selector}\``;
    case 'press':
      return `Press ${a.key}${a.selector ? ` in \`${a.selector}\`` : ''}`;
    case 'fill':
      return `Fill \`${a.selector}\` with ${JSON.stringify(a.value)}`;
    case 'select':
      return `Select ${JSON.stringify(a.value)} in \`${a.selector}\``;
    case 'wait':
      return `Wait ${a.ms}ms`;
    case 'waitFor':
      return `Wait for \`${a.selector}\` to be ${a.state ?? 'visible'}`;
  }
}

/**
 * Runs caller-supplied setup steps (e.g. open a dropdown) before inspection.
 * On non-loopback targets, clicks/keypresses on controls whose label looks
 * destructive, and submit buttons, are refused unless explicitly allowed.
 */
export async function runActions(
  page: Page,
  actions: readonly Action[],
  opts: { loopback: boolean; allowDestructive: boolean; timeoutMs: number },
): Promise<void> {
  for (const a of actions) {
    if (a.type === 'wait') {
      await page.waitForTimeout(a.ms);
      continue;
    }
    const loc = page.locator(a.selector ?? 'body').first();
    if (a.type === 'waitFor') {
      await loc.waitFor({ state: a.state ?? 'visible', timeout: opts.timeoutMs });
      continue;
    }
    if ((a.type === 'click' || a.type === 'press') && !opts.loopback && !opts.allowDestructive && a.selector) {
      const label = await loc.evaluate((el) => {
        const e = el as HTMLElement & { value?: string; type?: string };
        return {
          text: [e.innerText, e.value, e.getAttribute('aria-label'), e.getAttribute('title')].filter(Boolean).join(' '),
          submit: (e.tagName === 'BUTTON' || e.tagName === 'INPUT') && e.type === 'submit' && !!(e as HTMLButtonElement).form,
        };
      }, undefined, { timeout: opts.timeoutMs });
      if (DESTRUCTIVE.test(label.text) || label.submit) {
        throw new ActionPolicyError(
          `Refused to ${a.type} ${a.selector} ("${label.text.slice(0, 60)}"): it looks destructive or submits a form on a non-loopback target. ` +
            'Pass allowDestructiveActions: true only for environments where that is safe.',
        );
      }
    }
    switch (a.type) {
      case 'click':
        await loc.click({ timeout: opts.timeoutMs });
        break;
      case 'hover':
        await loc.hover({ timeout: opts.timeoutMs });
        break;
      case 'focus':
        await loc.focus({ timeout: opts.timeoutMs });
        break;
      case 'press':
        if (a.selector) await loc.press(a.key, { timeout: opts.timeoutMs });
        else await page.keyboard.press(a.key);
        break;
      case 'fill':
        await loc.fill(a.value, { timeout: opts.timeoutMs });
        break;
      case 'select':
        await loc.selectOption(a.value, { timeout: opts.timeoutMs });
        break;
    }
  }
}
