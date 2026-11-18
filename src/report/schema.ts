import * as z from 'zod';

export const CATEGORIES = [
  'overlap',
  'text-clipping',
  'viewport-overflow',
  'container-overflow',
  'offscreen-target',
  'obstructed-target',
  'clipped-target',
  'popup-clipping',
  'popup-placement',
  'misalignment',
  'inconsistent-spacing',
  'responsive-layout',
] as const;

export const SUPPRESSION_RULES = [
  'intentional-overlay',
  'fixed-or-sticky-media',
  'covered-by-open-modal',
  'covered-by-open-popup',
  'permitted-truncation',
  'reachable-on-focus',
  'intentional-stack',
  'overlay-on-media',
  'collapsed-container',
  'carousel-viewport',
  'hidden-content',
  'disclosure-present',
  'no-visible-change',
  'consolidated',
] as const;

export const Category = z.enum(CATEGORIES);
export const Severity = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export const Status = z.enum(['verified', 'potential', 'blocked']);
export const SuppressionRule = z.enum(SUPPRESSION_RULES);
export const ElementRole = z.enum(['subject', 'target', 'obstructor', 'container', 'trigger', 'related']);

export const RectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

export const ElementRefSchema = z.object({
  role: ElementRole,
  selector: z.string().describe('Unique CSS selector (Playwright `>>` chains into open shadow roots).'),
  tag: z.string(),
  id: z.string().nullable(),
  classes: z.string(),
  ariaRole: z.string().nullable(),
  name: z.string().describe('Accessible-name approximation (interactive/popup elements).'),
  text: z.string().describe('Direct text snippet.'),
  rect: RectSchema.describe('Border box, CSS px, viewport coords at scroll (0,0).'),
  visibleRect: RectSchema.nullable().describe('Border box after ancestor overflow clipping (and viewport for fixed).'),
  styles: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export const ConfigSchema = z.object({
  key: z.string(),
  label: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }).describe('Window size in device-independent px at 100% zoom.'),
  zoom: z.number(),
  cssViewport: z.object({ width: z.number(), height: z.number() }).describe('Layout viewport in CSS px after zoom.'),
  deviceScaleFactor: z.number(),
  colorScheme: z.enum(['light', 'dark']),
  browser: z.string(),
  browserVersion: z.string(),
  userAgent: z.string(),
  zoomEmulation: z.string(),
});

export const VisualCheckSchema = z.object({
  method: z.string(),
  description: z.string(),
  region: RectSchema,
  changedPixels: z.number(),
  totalPixels: z.number(),
  noisePixels: z.number(),
  conclusion: z.enum(['confirmed', 'not-visible', 'inconclusive']),
  note: z.string().optional(),
});

export const HitTestSchema = z.object({
  mode: z.string(),
  x: z.number(),
  y: z.number(),
  expected: z.string(),
  topSelector: z.string().nullable(),
  ok: z.boolean(),
});

export const EvidenceSchema = z.object({
  screenshot: z.string().nullable().describe('Annotated crop (PNG path).'),
  rawScreenshot: z.string().nullable().describe('Unannotated crop of the same region (PNG path).'),
  fullPageScreenshot: z.string().nullable(),
  visual: z.array(VisualCheckSchema),
  hitTests: z.array(HitTestSchema),
  stability: z
    .object({ remeasuredAfterMs: z.number(), maxDriftPx: z.number(), stable: z.boolean() })
    .nullable(),
  focusProbe: z.record(z.string(), z.unknown()).nullable(),
  scrollProbe: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe('Result of scrolling every scrollable ancestor to its end and re-measuring the element.'),
});

export const ReproductionSchema = z.object({
  steps: z.array(z.string()),
  consoleCheck: z.string().describe('Snippet to paste into DevTools (same viewport) that shows the measured condition.'),
});

export const OccurrenceSchema = z.object({
  configKey: z.string(),
  status: Status,
  severity: Severity,
  confidence: z.number(),
  measurements: z.record(z.string(), z.unknown()),
  screenshot: z.string().nullable(),
});

export const FindingSchema = z.object({
  id: z.string(),
  category: Category,
  title: z.string(),
  description: z.string(),
  status: Status,
  severity: Severity,
  confidence: z.number().min(0).max(1),
  confidenceLabel: z.enum(['high', 'medium', 'low']),
  page: z.object({ url: z.string(), title: z.string() }),
  config: ConfigSchema.describe('Primary configuration the evidence below was captured in.'),
  elements: z.array(ElementRefSchema),
  measurements: z.record(z.string(), z.unknown()),
  evidence: EvidenceSchema,
  reproduction: ReproductionSchema,
  occurrences: z.array(OccurrenceSchema),
  responsive: z
    .object({ failingConfigs: z.array(z.string()), passingConfigs: z.array(z.string()), note: z.string() })
    .nullable(),
  related: z.array(z.object({ findingId: z.string(), relation: z.string() })),
  notes: z.array(z.string()),
});

export const SuppressedSchema = z.object({
  category: Category,
  rule: SuppressionRule,
  reason: z.string(),
  configKey: z.string(),
  selectors: z.array(z.string()),
});

export const BlockedSchema = z.object({
  configKey: z.string().nullable(),
  stage: z.string(),
  reason: z.string(),
  detail: z.string(),
});

export const CoverageSchema = z.object({
  configsRequested: z.number(),
  configsCompleted: z.number(),
  checksRun: z.array(Category),
  elementsRecorded: z.number(),
  interactiveHitProbed: z.number(),
  scrolledProbes: z.number(),
  truncated: z.boolean(),
  iframesNotScanned: z.number(),
  openShadowRoots: z.number(),
  verificationBudgetExceeded: z.boolean(),
  limitations: z.array(z.string()),
});

export const ReportSchema = z.object({
  runId: z.string(),
  tool: z.object({ name: z.string(), version: z.string() }),
  target: z.object({ url: z.string() }),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  configs: z.array(ConfigSchema),
  summary: z.object({
    findings: z.number(),
    byStatus: z.record(z.string(), z.number()),
    bySeverity: z.record(z.string(), z.number()),
    byCategory: z.record(z.string(), z.number()),
    suppressed: z.number(),
    blocked: z.number(),
  }),
  findings: z.array(FindingSchema),
  suppressed: z.array(SuppressedSchema),
  blocked: z.array(BlockedSchema),
  coverage: CoverageSchema,
  diagnostics: z.object({
    httpStatus: z.record(z.string(), z.number().nullable()),
    consoleErrors: z.array(z.string()),
    failedRequests: z.array(z.string()),
  }),
  artifactsDir: z.string().nullable(),
  reportPath: z.string().nullable(),
});

export type CategoryT = z.infer<typeof Category>;
export type SeverityT = z.infer<typeof Severity>;
export type StatusT = z.infer<typeof Status>;
export type SuppressionRuleT = z.infer<typeof SuppressionRule>;
export type ElementRoleT = z.infer<typeof ElementRole>;
export type ElementRef = z.infer<typeof ElementRefSchema>;
export type RunConfigInfo = z.infer<typeof ConfigSchema>;
export type VisualCheck = z.infer<typeof VisualCheckSchema>;
export type HitTest = z.infer<typeof HitTestSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type Suppressed = z.infer<typeof SuppressedSchema>;
export type Blocked = z.infer<typeof BlockedSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
export type Report = z.infer<typeof ReportSchema>;

export const SEVERITY_RANK: Record<SeverityT, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
export const STATUS_RANK: Record<StatusT, number> = { verified: 2, potential: 1, blocked: 0 };
