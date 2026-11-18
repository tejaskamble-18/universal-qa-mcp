import * as z from 'zod';

/**
 * How an action or expectation identifies an element. Resolved with
 * Playwright locators (role/label/text first, CSS as a fallback).
 * `controlId` refers to a control in the session's most recent observation.
 */
export const TargetSchema = z.object({
  controlId: z.string().optional().describe('Ref of a control from the latest observation, e.g. "c12".'),
  role: z.string().optional().describe('ARIA role, used with name (getByRole).'),
  name: z.string().optional(),
  exact: z.boolean().optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  text: z.string().optional(),
  testId: z.string().optional(),
  selector: z.string().optional().describe('CSS selector (fallback).'),
  nth: z.number().int().min(0).optional().describe('Pick the nth match (0-based) when several match.'),
  within: z.string().optional().describe('CSS selector of a container to search inside.'),
  frame: z.string().optional().describe('CSS selector of an iframe to search inside.'),
});
export type Target = z.infer<typeof TargetSchema>;

/** Values may reference secrets as `${env:NAME}`; they are resolved at execution time and never logged. */
const Value = z.string();

export const OpActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string() }),
  z.object({ type: z.literal('back') }),
  z.object({ type: z.literal('forward') }),
  z.object({ type: z.literal('reload') }),
  z.object({
    type: z.literal('click'),
    target: TargetSchema,
    button: z.enum(['left', 'right', 'middle']).optional(),
    modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
  }),
  z.object({ type: z.literal('dblclick'), target: TargetSchema }),
  z.object({ type: z.literal('hover'), target: TargetSchema }),
  z.object({ type: z.literal('focus'), target: TargetSchema }),
  z.object({ type: z.literal('fill'), target: TargetSchema, value: Value }),
  z.object({ type: z.literal('type'), target: TargetSchema.optional(), text: Value, delayMs: z.number().int().min(0).max(500).optional() }),
  z.object({ type: z.literal('press'), key: z.string(), target: TargetSchema.optional() }),
  z.object({ type: z.literal('clear'), target: TargetSchema }),
  z.object({
    type: z.literal('select'),
    target: TargetSchema,
    value: z.string().optional(),
    label: z.string().optional(),
    index: z.number().int().min(0).optional(),
  }),
  z.object({ type: z.literal('check'), target: TargetSchema }),
  z.object({ type: z.literal('uncheck'), target: TargetSchema }),
  z.object({
    type: z.literal('scroll'),
    target: TargetSchema.optional(),
    direction: z.enum(['down', 'up', 'left', 'right']).optional(),
    amount: z.number().int().min(1).max(20_000).optional(),
    to: z.enum(['top', 'bottom']).optional(),
  }),
  z.object({ type: z.literal('scrollIntoView'), target: TargetSchema }),
  z.object({ type: z.literal('drag'), source: TargetSchema, target: TargetSchema }),
  z.object({ type: z.literal('upload'), target: TargetSchema, files: z.array(z.string()).min(1).max(10) }),
  z.object({ type: z.literal('switchTab'), index: z.number().int().min(0).optional(), urlMatches: z.string().optional() }),
  z.object({ type: z.literal('closeTab'), index: z.number().int().min(0).optional() }),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(30_000) }),
]);
export type OpAction = z.infer<typeof OpActionSchema>;

export const ExpectationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url'), matches: z.string().describe('Regular expression tested against the full URL.') }),
  z.object({ type: z.literal('visible'), target: TargetSchema }),
  z.object({ type: z.literal('hidden'), target: TargetSchema }),
  z.object({ type: z.literal('text'), contains: z.string(), within: z.string().optional() }),
  z.object({ type: z.literal('notText'), contains: z.string(), within: z.string().optional() }),
  z.object({
    type: z.literal('count'),
    target: TargetSchema,
    equals: z.number().int().optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('state'),
    target: TargetSchema,
    checked: z.boolean().optional(),
    expanded: z.boolean().optional(),
    selected: z.boolean().optional(),
    disabled: z.boolean().optional(),
    value: z.string().optional(),
  }),
  z.object({
    type: z.literal('request'),
    url: z.string().describe('Regular expression tested against request URLs issued during the action.'),
    method: z.string().optional(),
    status: z.union([z.number().int(), z.enum(['success', 'failure'])]).optional(),
    count: z.number().int().min(0).optional(),
  }),
  z.object({ type: z.literal('noRequest'), url: z.string(), method: z.string().optional() }),
  z.object({ type: z.literal('dialog'), kind: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']).optional(), messageContains: z.string().optional() }),
  z.object({ type: z.literal('popup'), urlMatches: z.string().optional() }),
  z.object({ type: z.literal('download'), filenameMatches: z.string().optional() }),
  z.object({ type: z.literal('alert'), contains: z.string() }),
  z.object({ type: z.literal('noConsoleErrors') }),
  z.object({ type: z.literal('stateChanged') }),
]);
export type Expectation = z.infer<typeof ExpectationSchema>;

export const DialogPolicySchema = z.object({ accept: z.boolean(), promptText: z.string().optional() });
export type DialogPolicy = z.infer<typeof DialogPolicySchema>;

/** Options attached to one action (a workflow step or a ui_act call). */
export const ActOptionsSchema = z.object({
  expect: z.array(ExpectationSchema).max(20).optional(),
  write: z.boolean().optional().describe('Declares that this action writes data. Required for write-classified actions.'),
  idempotencyKey: z.string().optional(),
  allowRepeat: z.boolean().optional().describe('Allow repeating a write already performed in this session.'),
  dialog: DialogPolicySchema.optional(),
  retries: z.number().int().min(0).max(3).optional(),
  expectTimeoutMs: z.number().int().min(0).max(30_000).optional(),
});
export type ActOptions = z.infer<typeof ActOptionsSchema>;

export type ActionStatus =
  /** Expected outcome (explicit or derived from the control's semantics) was observed. */
  | 'passed'
  /** Executed and something observable changed, but no expected outcome was available to check. Not a success. */
  | 'performed'
  /** Executed, nothing observable changed, no expectation given. */
  | 'no-effect'
  /** An expectation was not met, or execution failed. */
  | 'failed'
  /** The browser could not interact: intercepted, hidden, disabled, off-screen, missing, ambiguous. */
  | 'blocked'
  /** Not executed: safety policy (unapproved write, disallowed upload, out of scope). */
  | 'refused'
  | 'duplicate-prevented'
  /** CAPTCHA, authentication challenge, blocked access or expired session: a human must act. */
  | 'needs-operator'
  /** A write request was sent but its outcome could not be confirmed; it was not retried. */
  | 'outcome-unknown';

export type ActionKind = 'read' | 'local' | 'write';

export interface ExpectationResult {
  description: string;
  source: 'explicit' | 'intrinsic';
  passed: boolean;
  expected: string;
  actual: string;
}

export interface RequestRecord {
  seq: number;
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  failure: string | null;
  blockedByGuard: string | null;
  page: number;
}

export interface ObservedControl {
  ref: string;
  selector: string;
  role: string;
  name: string;
  tag: string;
  type: string | null;
  href: string | null;
  target: string | null;
  bbox: { x: number; y: number; w: number; h: number };
  inViewport: boolean;
  enabled: boolean;
  state: {
    expanded?: boolean;
    checked?: boolean;
    selected?: boolean;
    pressed?: boolean;
    value?: string;
    required?: boolean;
    invalid?: boolean;
    haspopup?: string;
    draggable?: boolean;
  };
  form: number;
  overlay: number;
  submit: boolean;
  signature: string;
}

export interface Challenge {
  kind: 'captcha' | 'auth' | 'mfa' | 'blocked' | 'session-expired';
  reason: string;
  evidence: string;
}

export interface Observation {
  url: string;
  title: string;
  route: string;
  fingerprint: string;
  textHash: string;
  controls: ObservedControl[];
  forms: { index: number; selector: string; method: string; action: string; fields: string[]; submits: string[] }[];
  overlays: { index: number; selector: string; role: string; name: string }[];
  alerts: { role: string; text: string }[];
  headings: string[];
  focused: string | null;
  passwordFieldVisible: boolean;
  challenge: Challenge | null;
  truncated: boolean;
}

export interface ActionEffects {
  urlBefore: string;
  urlAfter: string;
  navigated: boolean;
  fingerprintChanged: boolean;
  textChanged: boolean;
  visualChangeRatio: number | null;
  visualChangedPixels: number | null;
  overlaysOpened: string[];
  overlaysClosed: string[];
  alerts: string[];
  requests: { method: string; url: string; status: number | null; failure: string | null; blockedByGuard: string | null }[];
  writeRequests: number;
  duplicateWritesBlocked: number;
  dialogs: { type: string; message: string; handled: string }[];
  popups: string[];
  downloads: { filename: string; path: string | null }[];
  consoleErrors: string[];
  pageErrors: string[];
  settled: boolean;
}

export interface Attempt {
  n: number;
  startedAt: string;
  durationMs: number;
  outcome: string;
  error: { kind: string; message: string } | null;
}

export interface ActionResult {
  seq: number;
  at: string;
  description: string;
  action: OpAction;
  kind: ActionKind;
  classificationReason: string;
  status: ActionStatus;
  reason: string;
  attempts: Attempt[];
  expectations: ExpectationResult[];
  effects: ActionEffects | null;
  interceptedBy: string | null;
  challenge: Challenge | null;
  evidence: { before: string | null; after: string | null; firstEventSeq: number; lastEventSeq: number };
  observation: { url: string; title: string; fingerprint: string; controls: number; overlays: string[]; alerts: string[] } | null;
  notes: string[];
}
