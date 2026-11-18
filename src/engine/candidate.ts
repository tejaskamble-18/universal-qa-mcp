import type { CategoryT, ElementRoleT, SeverityT, SuppressionRuleT } from '../report/schema.js';
import type { SnapshotModel } from './model.js';
import type { Rect } from './snapshot-types.js';

/**
 * A verification step the verifier runs against the live page.
 * Regions are in snapshot coordinates (viewport px at scroll 0,0); the
 * verifier re-locates them after scrolling, using `anchor`'s displacement.
 */
export type VerifyPlan =
  /** Hide a, then b; both must visibly paint inside `region`. */
  | { kind: 'overlap'; a: number; b: number; region: Rect }
  /**
   * Restore the probe's scroll position, re-hit-test the target at (fx, fy) of its box, then hide
   * the obstructor to see whether it visibly covers the target.
   */
  | { kind: 'cover'; obstructor: number; target: number; fx: number; fy: number; scroll: { x: number; y: number } }
  /** Make `clipper` overflow:visible; hidden content must appear inside `region` without the layout moving. */
  | { kind: 'unclip'; clipper: number; element: number; region: Rect }
  /** Hide `element`; pixels outside its container (in `region`) must change. */
  | { kind: 'spill'; container: number; element: number; region: Rect }
  /**
   * Recolour `text` and compare with/without `occluder`: the text must be (mostly) invisible now
   * and appear once the occluder subtree is hidden.
   */
  | { kind: 'occlusion'; text: number; occluder: number; region: Rect }
  /** Focus the element and check whether it becomes visible (skip-link pattern). */
  | { kind: 'focus'; element: number }
  /** Prove the window can really scroll horizontally. */
  | { kind: 'hscroll' }
  /** Scroll everything that can scroll to its end; the element must still extend past the viewport. */
  | { kind: 'reach'; element: number };

export interface CandidateElement {
  index: number;
  role: ElementRoleT;
}

export interface Candidate {
  category: CategoryT;
  /** Dedupe key within one configuration. */
  key: string;
  title: string;
  description: string;
  severity: SeverityT;
  /** Prior confidence from geometry alone, 0..1; verification adjusts it. */
  confidence: number;
  /** Heuristic (design-consistency) checks are capped at 'potential'. */
  maxStatus: 'verified' | 'potential';
  elements: CandidateElement[];
  measurements: Record<string, unknown>;
  verify: VerifyPlan[];
  consoleCheck: string;
  notes: string[];
  suppressed?: { rule: SuppressionRuleT; reason: string };
  /** Links to other candidates (by key) in the same configuration. */
  related?: { key: string; relation: string }[];
  /**
   * Grouped candidates: regenerate title/description/measurements for a subset
   * of subject indices after consolidation removes members. Returns null when
   * no members remain.
   */
  rebuild?: (keepSubjects: number[]) => Candidate | null;
}

export interface Thresholds {
  /** Minimum overlap extent (px) in both axes. */
  overlapMinPx: number;
  overlapMinArea: number;
  /** Minimum hidden extent (px) for clipping findings. */
  clipMinPx: number;
  clipMinFraction: number;
  viewportOverflowMinPx: number;
  containerOverflowMinPx: number;
  offscreenMinPx: number;
  popupDetachPx: number;
  alignTolerancePx: number;
  alignMinDeviationPx: number;
  alignMaxDeviationPx: number;
  spacingTolerancePx: number;
  spacingMinDeviationPx: number;
  spacingMinRelative: number;
  /** Pixel channel delta treated as "changed" in visual diffs. */
  pixelDelta: number;
  /** Changed pixels (beyond baseline noise) needed to call a visual check confirmed. */
  visualMinChangedPixels: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  overlapMinPx: 3,
  overlapMinArea: 24,
  clipMinPx: 3,
  clipMinFraction: 0.04,
  viewportOverflowMinPx: 2,
  containerOverflowMinPx: 4,
  offscreenMinPx: 3,
  popupDetachPx: 48,
  alignTolerancePx: 0.75,
  alignMinDeviationPx: 2,
  alignMaxDeviationPx: 16,
  spacingTolerancePx: 1,
  spacingMinDeviationPx: 4,
  spacingMinRelative: 0.25,
  pixelDelta: 24,
  visualMinChangedPixels: 6,
};

export interface DetectorContext {
  model: SnapshotModel;
  t: Thresholds;
}

export interface Detector {
  category: CategoryT;
  /** One-line description for qa_list_checks. */
  description: string;
  run(ctx: DetectorContext): Candidate[];
}

export const cssq = (selector: string): string => JSON.stringify(selector.split(' >> ').pop() ?? selector);
