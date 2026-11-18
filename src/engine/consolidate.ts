import type { Candidate } from './candidate.js';
import type { SnapshotModel } from './model.js';
import type { VerifiedCandidate } from './verify.js';

const subjects = (c: Candidate): number[] => c.elements.filter((e) => e.role === 'subject').map((e) => e.index);
const withRole = (c: Candidate, role: string): number[] => c.elements.filter((e) => e.role === role).map((e) => e.index);

function relate(c: Candidate, other: Candidate, relation: string): void {
  c.related ??= [];
  if (!c.related.some((r) => r.key === other.key)) c.related.push({ key: other.key, relation });
}

/** Remove subjects; grouped candidates regenerate their text so it never names removed members. */
function dropSubjects(c: Candidate, drop: Set<number>): void {
  const keep = subjects(c).filter((s) => !drop.has(s));
  const rebuilt = c.rebuild?.(keep);
  if (rebuilt) {
    const { related, notes } = c;
    Object.assign(c, rebuilt, { related, notes: [...new Set([...notes, ...rebuilt.notes])] });
    return;
  }
  c.elements = c.elements.filter((e) => e.role !== 'subject' || !drop.has(e.index));
}

/**
 * Merge symptoms that share one root cause so a defect is reported once, with
 * the other observations attached as evidence. Mutates and returns the list.
 */
export function consolidate(model: SnapshotModel, all: Candidate[]): Candidate[] {
  const live = all.filter((c) => !c.suppressed);
  const by = (cat: Candidate['category']): Candidate[] => live.filter((c) => c.category === cat);
  const removed = new Set<Candidate>();

  // (Overlap + obstruction of the same pair is merged after verification: see mergeObstructions.)

  // 2. Popup clipping explains clipping/off-screen findings for its own descendants.
  for (const pc of by('popup-clipping')) {
    const [popup] = subjects(pc);
    if (popup === undefined) continue;
    for (const other of live) {
      if (other === pc || removed.has(other)) continue;
      if (!['clipped-target', 'text-clipping', 'offscreen-target'].includes(other.category)) continue;
      const inside = new Set(subjects(other).filter((s) => s === popup || model.isAncestor(popup, s)));
      if (!inside.size) continue;
      dropSubjects(other, inside);
      pc.notes.push(`Also hides ${[...inside].map((i) => model.label(i)).join(', ')}.`);
      if (!subjects(other).length) removed.add(other);
    }
  }

  // 3. A clipped control already reports its own text being cut by the same clipper.
  for (const ct of by('clipped-target')) {
    if (removed.has(ct)) continue;
    const [clipper] = withRole(ct, 'container');
    const controls = subjects(ct);
    for (const tc of by('text-clipping')) {
      if (removed.has(tc)) continue;
      const tcClipper = withRole(tc, 'container')[0] ?? subjects(tc)[0];
      if (tcClipper !== clipper) continue;
      const covered = new Set(subjects(tc).filter((s) => controls.some((c) => c === s || model.isAncestor(c, s))));
      if (!covered.size) continue;
      dropSubjects(tc, covered);
      if (!subjects(tc).length) removed.add(tc);
    }
  }

  // 4. Off-screen + clipped for the same control: the clipped-target finding owns it.
  for (const off of by('offscreen-target')) {
    if (removed.has(off)) continue;
    const [s] = subjects(off);
    if (s === undefined) continue;
    if (by('clipped-target').some((ct) => !removed.has(ct) && subjects(ct).includes(s))) removed.add(off);
  }

  // 5. Relations (kept as separate findings, cross-referenced).
  for (const co of by('container-overflow')) {
    const spilled = co.elements.filter((e) => e.role === 'target').map((e) => e.index);
    for (const ov of by('overlap')) {
      if (subjects(ov).some((s) => spilled.some((d) => d === s || model.isAncestor(d, s)))) {
        relate(ov, co, 'likely-root-cause');
        relate(co, ov, 'causes');
        if (co.severity === 'low' || co.severity === 'medium') co.severity = 'high';
      }
    }
  }
  for (const vo of by('viewport-overflow')) {
    for (const pc of by('popup-clipping')) {
      const [popup] = subjects(pc);
      if (popup !== undefined && subjects(vo).some((s) => s === popup || model.isAncestor(popup, s))) {
        relate(vo, pc, 'caused-by');
        relate(pc, vo, 'causes');
      }
    }
  }

  return all.filter((c) => !removed.has(c));
}

/**
 * After verification: when an overlap between A and B survived (it visibly
 * paints) and hit-testing also showed B intercepting clicks on A, report it
 * once as the overlap, carrying the hit-test evidence. Done post-verification
 * so a suppressed overlap (e.g. a control fully under an opaque panel) never
 * swallows the obstruction finding.
 */
export function mergeObstructions(model: SnapshotModel, results: VerifiedCandidate[]): VerifiedCandidate[] {
  const removed = new Set<VerifiedCandidate>();
  const overlaps = results.filter((r) => !r.suppressed && r.cand.category === 'overlap' && r.status !== 'blocked');
  for (const ob of results) {
    if (ob.suppressed || ob.cand.category !== 'obstructed-target') continue;
    const [obstructor] = withRole(ob.cand, 'obstructor');
    if (obstructor === undefined) continue;
    const merged = new Set<number>();
    for (const target of subjects(ob.cand)) {
      for (const ov of overlaps) {
        const [a, b] = subjects(ov.cand);
        if (a === undefined || b === undefined) continue;
        const match =
          (model.related(a, target) && model.related(b, obstructor)) ||
          (model.related(b, target) && model.related(a, obstructor));
        if (!match) continue;
        const sel = model.el(target).selector;
        ov.cand.measurements.hitTest =
          (ob.cand.measurements.targets as { selector: string }[] | undefined)?.find((x) => x.selector === sel) ?? null;
        ov.evidence.hitTests.push(...ob.evidence.hitTests.filter((h) => h.expected === sel));
        ov.notes.push(`Hit-testing confirms ${model.label(obstructor)} receives clicks aimed at ${model.label(target)}.`);
        if (model.el(target).flags.interactive) {
          ov.severity = 'high';
          ov.cand.title = 'Overlapping content intercepts clicks on a control';
        }
        merged.add(target);
      }
    }
    if (!merged.size) continue;
    dropSubjects(ob.cand, merged);
    const targets = ob.cand.measurements.targets as { selector: string }[] | undefined;
    if (targets) {
      const gone = new Set([...merged].map((m) => model.el(m).selector));
      ob.cand.measurements.targets = targets.filter((x) => !gone.has(x.selector));
    }
    if (!subjects(ob.cand).length) removed.add(ob);
  }
  return dedupeOcclusions(model, results.filter((r) => !removed.has(r)));
}

/** Text occlusion already explained by a surviving content-pair overlap is reported once, as the overlap. */
function dedupeOcclusions(model: SnapshotModel, results: VerifiedCandidate[]): VerifiedCandidate[] {
  const pairs = results.filter(
    (r) => !r.suppressed && r.cand.category === 'overlap' && r.cand.measurements.variant !== 'occlusion' && r.status !== 'blocked',
  );
  const removed = new Set<VerifiedCandidate>();
  for (const oc of results) {
    if (oc.suppressed || oc.cand.measurements.variant !== 'occlusion') continue;
    const [occ] = withRole(oc.cand, 'obstructor');
    if (occ === undefined) continue;
    const explained = new Set(
      subjects(oc.cand).filter((t) =>
        pairs.some((p) => {
          const [a, b] = subjects(p.cand);
          if (a === undefined || b === undefined) return false;
          return (model.related(a, t) && model.related(b, occ)) || (model.related(b, t) && model.related(a, occ));
        }),
      ),
    );
    if (!explained.size) continue;
    dropSubjects(oc.cand, explained);
    if (!subjects(oc.cand).length) removed.add(oc);
  }
  return results.filter((r) => !removed.has(r));
}
