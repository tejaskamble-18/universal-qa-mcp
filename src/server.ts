import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { ActionSchema } from './browser/actions.js';
import { BrowserManager, type ConfigRequest } from './browser/session.js';
import { DEFAULT_COLLECT, DEFAULT_CONFIGS, runAudit, TOOL_NAME, TOOL_VERSION } from './engine/audit.js';
import { DEFAULT_THRESHOLDS } from './engine/candidate.js';
import { DETECTORS, RESPONSIVE_DESCRIPTION } from './engine/detectors/index.js';
import { inspectElement } from './engine/inspect.js';
import { formatSummary } from './report/format.js';
import { Category, type Report, ReportSchema, SUPPRESSION_RULES } from './report/schema.js';
import type { OperatorDeps } from './operator/open.js';
import { uploadRootsFromEnv, writeAllowedOrigins } from './operator/operator.js';
import { SessionStore } from './operator/sessions.js';
import { checkUrl, policyFromEnv } from './safety/policy.js';
import { OPERATOR_INSTRUCTIONS, registerOperatorTools } from './server-operator.js';

export const INSTRUCTIONS = `Universal QA MCP: deterministic, evidence-based UI layout auditing.
Use qa_audit_layout to measure a page at several viewports/zoom levels. Every finding is backed by DOM geometry
(bounding boxes, clip chains, hit tests) and, where possible, a pixel-differential screenshot check.
Status meanings: "verified" = the defect condition was measured and re-confirmed in the live page;
"potential" = measured anomaly whose defect-ness depends on design intent or could not be re-confirmed;
"blocked" = the check could not run. Intentional patterns (open modals, popups, ellipsis, line-clamp, skip links,
stack patterns, overlays on media, collapsed accordions, carousels) are listed under "suppressed" with reasons.
Screenshots document the state; the measurements, not the screenshot, establish the defect. Style values in
measurements are root-cause hints, not proof. Only loopback/file URLs are allowed unless QA_MCP_ALLOWED_ORIGINS
authorises an origin. The server never submits forms or clicks destructive-looking controls on non-loopback
targets unless allowDestructiveActions is set.`;

const ViewportSchema = z.object({
  width: z.number().int().min(200).max(4000),
  height: z.number().int().min(200).max(4000),
});

const AuditInput = z.object({
  url: z.string().describe('Absolute URL of the page to audit (http(s) or file).'),
  viewports: z.array(ViewportSchema).max(8).optional().describe('Window sizes at 100% zoom. Default: 375×812, 768×1024, 1280×800.'),
  zoomLevels: z.array(z.number().min(0.25).max(5)).max(5).optional().describe('Browser zoom factors applied to every viewport (1 = 100%). Default [1].'),
  colorScheme: z.enum(['light', 'dark']).optional(),
  actions: z.array(ActionSchema).max(30).optional().describe('Setup steps before inspection, e.g. open a dropdown: [{"type":"click","selector":"#menu-button"}].'),
  allowDestructiveActions: z.boolean().optional().describe('Allow clicks on submit/destructive-looking controls on non-loopback targets. Default false.'),
  checks: z.array(Category).optional().describe('Subset of checks to run. Default: all.'),
  ignoreSelectors: z.array(z.string()).max(50).optional().describe('Elements (and their subtrees) to exclude as finding subjects.'),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
  settleMs: z.number().int().min(0).max(30_000).optional().describe('Extra settle time after load/actions. Default 300.'),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  maxVerifyPerConfig: z.number().int().min(0).max(200).optional().describe('Max candidates verified in the live page per configuration. Default 40.'),
  includeImages: z.number().int().min(0).max(10).optional().describe('Embed annotated evidence screenshots of the top N findings in the result. Default 0.'),
});

const InspectInput = z.object({
  url: z.string(),
  selector: z.string().describe('CSS selector (first match) of the element to measure.'),
  viewport: ViewportSchema.optional(),
  zoom: z.number().min(0.25).max(5).optional(),
  colorScheme: z.enum(['light', 'dark']).optional(),
  actions: z.array(ActionSchema).max(30).optional(),
  allowDestructiveActions: z.boolean().optional(),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
  settleMs: z.number().int().min(0).max(30_000).optional(),
});

const EvidenceInput = z.object({
  runId: z.string(),
  findingId: z.string(),
  image: z.enum(['annotated', 'raw', 'full-page']).optional().describe('Which screenshot to return. Default annotated.'),
});

export interface ServerDeps extends OperatorDeps {
  log: (msg: string) => void;
}

export function defaultDeps(): ServerDeps {
  const browsers = new BrowserManager();
  const policy = policyFromEnv();
  const base = resolve(process.env.QA_MCP_ARTIFACTS_DIR ?? join(tmpdir(), 'universal-qa-mcp', 'runs'));
  const sessionsDir = resolve(process.env.QA_MCP_SESSIONS_DIR ?? join(tmpdir(), 'universal-qa-mcp', 'sessions'));
  return {
    browsers,
    policy,
    artifactsRoot: base,
    sessions: new SessionStore(sessionsDir, browsers, policy),
    writeOrigins: writeAllowedOrigins(),
    uploadRoots: uploadRootsFromEnv(),
    log: (m) => process.stderr.write(`[${TOOL_NAME}] ${m}\n`),
  };
}

const text = (t: string) => ({ type: 'text' as const, text: t });
const errorResult = (msg: string) => ({ content: [text(msg)], isError: true });

/** Recent reports kept in memory; older ones are re-read from disk. */
class RunStore {
  private runs = new Map<string, Report>();
  constructor(private root: string) {}
  put(r: Report): void {
    this.runs.set(r.runId, r);
    if (this.runs.size > 20) this.runs.delete(this.runs.keys().next().value!);
  }
  get(runId: string): Report | null {
    const hit = this.runs.get(runId);
    if (hit) return hit;
    if (!/^run-[\w-]+$/.test(runId)) return null;
    const p = join(this.root, runId, 'report.json');
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Report) : null;
  }
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: TOOL_NAME, version: TOOL_VERSION }, { capabilities: { tools: {} }, instructions: `${INSTRUCTIONS}

${OPERATOR_INSTRUCTIONS}` });
  const store = new RunStore(deps.artifactsRoot);
  let idle: NodeJS.Timeout | null = null;
  const touch = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => void deps.browsers.close(), 5 * 60_000);
    idle.unref();
  };

  server.registerTool(
    'qa_audit_layout',
    {
      title: 'Audit page layout (geometry engine)',
      description:
        'Deterministically audit a web page for layout defects at multiple viewports and zoom levels: overlapping content, clipped text, ' +
        'horizontal/viewport overflow, container overflow, off-screen/obstructed/clipped controls, clipped or misplaced dropdowns and dialogs, ' +
        'misalignment, inconsistent spacing and responsive regressions. Returns structured findings with selectors, measurements, ' +
        'screenshot evidence, reproduction steps, severity, confidence and verified/potential/blocked status.',
      inputSchema: AuditInput,
      outputSchema: ReportSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const pol = checkUrl(args.url, deps.policy);
      if (!pol.ok) return errorResult(pol.reason);
      const viewports = args.viewports?.length ? args.viewports : DEFAULT_CONFIGS.map((c) => ({ width: c.width, height: c.height }));
      const zooms = args.zoomLevels?.length ? args.zoomLevels : [1];
      const configs: ConfigRequest[] = viewports.flatMap((v) =>
        zooms.map((zoom) => ({ width: v.width, height: v.height, zoom, colorScheme: args.colorScheme ?? 'light' })),
      );
      if (configs.length > 24) return errorResult(`Too many configurations (${configs.length}); the limit is 24.`);
      touch();
      try {
        const report = await runAudit(deps.browsers, {
          url: pol.url.href,
          configs,
          actions: args.actions ?? [],
          allowDestructiveActions: args.allowDestructiveActions ?? false,
          checks: args.checks,
          waitUntil: args.waitUntil ?? 'load',
          settleMs: args.settleMs ?? 300,
          timeoutMs: args.timeoutMs ?? 30_000,
          ignoreSelectors: args.ignoreSelectors ?? [],
          maxVerifyPerConfig: args.maxVerifyPerConfig ?? 40,
          artifactsRoot: deps.artifactsRoot,
          policy: deps.policy,
          log: deps.log,
        });
        store.put(report);
        const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [text(formatSummary(report))];
        for (const f of report.findings.slice(0, args.includeImages ?? 0)) {
          if (f.evidence.screenshot && existsSync(f.evidence.screenshot)) {
            content.push(text(`Evidence for ${f.id} (${f.category}, ${f.config.label}):`));
            content.push({ type: 'image', data: readFileSync(f.evidence.screenshot).toString('base64'), mimeType: 'image/png' });
          }
        }
        return { content, structuredContent: report as unknown as Record<string, unknown> };
      } catch (err) {
        return errorResult(`Audit failed: ${(err as Error).message}`);
      } finally {
        touch();
      }
    },
  );

  server.registerTool(
    'qa_inspect_element',
    {
      title: 'Inspect one element\'s geometry',
      description:
        'Measure a single element for root-cause analysis: bounding box, visible box after clipping, the chain of clipping ancestors ' +
        '(containing-block aware), reachable scroll region, stacking layer, hit-test samples (what receives clicks), text clipping and ' +
        'unverified detector candidates that involve it.',
      inputSchema: InspectInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const pol = checkUrl(args.url, deps.policy);
      if (!pol.ok) return errorResult(pol.reason);
      touch();
      try {
        const result = await inspectElement(deps.browsers, {
          url: pol.url.href,
          selector: args.selector,
          config: {
            width: args.viewport?.width ?? 1280,
            height: args.viewport?.height ?? 800,
            zoom: args.zoom ?? 1,
            colorScheme: args.colorScheme ?? 'light',
          },
          policy: deps.policy,
          actions: args.actions ?? [],
          allowDestructiveActions: args.allowDestructiveActions ?? false,
          waitUntil: args.waitUntil ?? 'load',
          settleMs: args.settleMs ?? 300,
          timeoutMs: 30_000,
          collect: DEFAULT_COLLECT,
          thresholds: DEFAULT_THRESHOLDS,
        });
        return { content: [text(JSON.stringify(result, null, 2))] };
      } catch (err) {
        return errorResult(`Inspection failed: ${(err as Error).message}`);
      } finally {
        touch();
      }
    },
  );

  server.registerTool(
    'qa_get_evidence',
    {
      title: 'Get finding evidence',
      description: 'Return a finding from a previous qa_audit_layout run together with its screenshot evidence image.',
      inputSchema: EvidenceInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const report = store.get(args.runId);
      if (!report) return errorResult(`Unknown run ${args.runId}.`);
      const f = report.findings.find((x) => x.id === args.findingId);
      if (!f) return errorResult(`Run ${args.runId} has no finding ${args.findingId}.`);
      const which = args.image ?? 'annotated';
      const path =
        which === 'raw' ? f.evidence.rawScreenshot : which === 'full-page' ? f.evidence.fullPageScreenshot : f.evidence.screenshot;
      const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [
        text(JSON.stringify(f, null, 2)),
      ];
      if (path && existsSync(path)) {
        content.push({ type: 'image', data: readFileSync(path).toString('base64'), mimeType: 'image/png' });
      } else {
        content.push(text(`No ${which} screenshot is available for this finding.`));
      }
      return { content };
    },
  );

  server.registerTool(
    'qa_list_checks',
    {
      title: 'List layout checks',
      description: 'Describe every check, its thresholds, the suppression (intentional-pattern) rules and the status definitions.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const info = {
        checks: [
          ...DETECTORS.map((d) => ({ category: d.category, description: d.description })),
          { category: 'responsive-layout', description: RESPONSIVE_DESCRIPTION },
        ],
        thresholds: DEFAULT_THRESHOLDS,
        suppressionRules: SUPPRESSION_RULES,
        defaultConfigs: DEFAULT_CONFIGS,
        targetPolicy: {
          loopbackAndFileAllowed: true,
          allowedOrigins: deps.policy.allowed,
          allowAny: deps.policy.allowAny,
        },
      };
      return { content: [text(INSTRUCTIONS), text(JSON.stringify(info, null, 2))] };
    },
  );

  registerOperatorTools(server, deps);
  return server;
}
