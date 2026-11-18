import type { Finding, Report } from './schema.js';

function sel(f: Finding): string {
  const subj = f.elements.find((e) => e.role === 'subject') ?? f.elements[0];
  return subj ? subj.selector : '(page)';
}

/** Compact text summary for the MCP tool result. */
export function formatSummary(r: Report, maxFindings = 40): string {
  const lines: string[] = [];
  const s = r.summary;
  lines.push(`Universal QA layout audit — ${r.target.url}`);
  lines.push(`Run ${r.runId}: ${r.coverage.configsCompleted}/${r.coverage.configsRequested} configurations in ${Math.round(r.durationMs / 100) / 10}s`);
  lines.push(`Configs: ${r.configs.map((c) => c.label).join(' | ') || 'none'}`);
  lines.push(
    `Findings: ${s.findings} (verified ${s.byStatus.verified ?? 0}, potential ${s.byStatus.potential ?? 0}, blocked ${s.byStatus.blocked ?? 0}); ` +
      `suppressed as intentional: ${s.suppressed}; blocked steps: ${s.blocked}`,
  );
  lines.push('');
  for (const f of r.findings.slice(0, maxFindings)) {
    lines.push(`[${f.id}] ${f.status.toUpperCase()} ${f.severity} (${f.confidenceLabel} ${f.confidence}) ${f.category}: ${f.title}`);
    lines.push(`    ${sel(f)} @ ${f.config.label}${f.responsive ? ` — ${f.responsive.note}` : ''}`);
    lines.push(`    ${f.description}`);
    if (f.evidence.screenshot) lines.push(`    evidence: ${f.evidence.screenshot}`);
  }
  if (r.findings.length > maxFindings) lines.push(`… ${r.findings.length - maxFindings} more in the structured result / report file.`);
  if (r.blocked.length) {
    lines.push('', 'Blocked:');
    for (const b of r.blocked) lines.push(`  - [${b.configKey ?? '-'}] ${b.stage}: ${b.reason} — ${b.detail}`);
  }
  if (r.reportPath) lines.push('', `Full report: ${r.reportPath}`);
  return lines.join('\n');
}

/** Markdown report written next to report.json. */
export function formatMarkdown(r: Report): string {
  const out: string[] = [];
  out.push(`# Layout audit: ${r.target.url}`, '');
  out.push(`- Run: \`${r.runId}\` (${r.startedAt} → ${r.finishedAt})`);
  out.push(`- Tool: ${r.tool.name} ${r.tool.version}`);
  out.push(`- Configurations: ${r.configs.map((c) => `${c.label} (CSS ${c.cssViewport.width}×${c.cssViewport.height})`).join('; ')}`);
  out.push(
    `- Findings: **${r.summary.findings}** — ` +
      Object.entries(r.summary.byStatus).map(([k, v]) => `${k} ${v}`).join(', ') +
      `; suppressed as intentional: ${r.summary.suppressed}; blocked steps: ${r.summary.blocked}`,
    '',
  );
  out.push('| ID | Status | Severity | Category | Element | Config | Title |', '|---|---|---|---|---|---|---|');
  for (const f of r.findings) {
    out.push(`| ${f.id} | ${f.status} | ${f.severity} | ${f.category} | \`${sel(f).replace(/\|/g, '\\|')}\` | ${f.config.label} | ${f.title} |`);
  }
  for (const f of r.findings) {
    out.push('', `## ${f.id} — ${f.title}`, '');
    out.push(`**${f.status}**, ${f.severity}, confidence ${f.confidence} (${f.confidenceLabel}). Category \`${f.category}\`.`, '');
    out.push(f.description, '');
    if (f.responsive) out.push(`Responsive: ${f.responsive.note}`, '');
    out.push('Elements:');
    for (const e of f.elements) out.push(`- ${e.role}: \`${e.selector}\` rect ${e.rect.x},${e.rect.y} ${e.rect.w}×${e.rect.h}${e.name || e.text ? ` — "${(e.name || e.text).slice(0, 50)}"` : ''}`);
    out.push('', 'Measurements:', '```json', JSON.stringify(f.measurements, null, 2), '```');
    if (f.evidence.visual.length) {
      out.push('Visual checks:');
      for (const v of f.evidence.visual) out.push(`- ${v.method}: ${v.conclusion} (${v.changedPixels}/${v.totalPixels} px changed, noise ${v.noisePixels}) — ${v.description}`);
    }
    if (f.evidence.screenshot) out.push('', `![evidence](${f.evidence.screenshot.replace(/\\/g, '/')})`);
    out.push('', 'Reproduction:');
    f.reproduction.steps.forEach((s, k) => out.push(`${k + 1}. ${s}`));
    out.push('', 'Console check:', '```js', f.reproduction.consoleCheck, '```');
    if (f.notes.length) out.push('', 'Notes:', ...f.notes.map((n) => `- ${n}`));
  }
  if (r.suppressed.length) {
    out.push('', '## Suppressed as intentional', '');
    for (const s of r.suppressed) out.push(`- [${s.configKey}] ${s.category} / ${s.rule}: ${s.reason}`);
  }
  if (r.blocked.length) {
    out.push('', '## Blocked', '');
    for (const b of r.blocked) out.push(`- [${b.configKey ?? '-'}] ${b.stage}: ${b.reason} — ${b.detail}`);
  }
  out.push('', '## Coverage and limitations', '');
  out.push(`- Elements recorded: ${r.coverage.elementsRecorded}; interactive elements hit-tested: ${r.coverage.interactiveHitProbed}`);
  out.push(...r.coverage.limitations.map((l) => `- ${l}`));
  return out.join('\n');
}
