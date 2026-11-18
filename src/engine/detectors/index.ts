import type { CategoryT } from '../../report/schema.js';
import type { Detector } from '../candidate.js';
import { clippedTargetDetector, textClippingDetector } from './clipping.js';
import { misalignmentDetector, spacingDetector } from './consistency.js';
import { obstructedTargetDetector, popupClippingDetector, popupPlacementDetector } from './interaction.js';
import { occludedTextDetector, overlapDetector } from './overlap.js';
import { containerOverflowDetector, offscreenTargetDetector, viewportOverflowDetector } from './overflow.js';

/** Per-configuration detectors. `responsive-layout` is computed across configurations (see aggregate.ts). */
export const DETECTORS: readonly Detector[] = [
  overlapDetector,
  occludedTextDetector,
  textClippingDetector,
  viewportOverflowDetector,
  containerOverflowDetector,
  offscreenTargetDetector,
  obstructedTargetDetector,
  clippedTargetDetector,
  popupClippingDetector,
  popupPlacementDetector,
  misalignmentDetector,
  spacingDetector,
];

export const RESPONSIVE_DESCRIPTION =
  'Cross-configuration: controls that are visible at a wider configuration but not rendered at a narrower one, with no visible ' +
  'disclosure control (menu button, summary, aria-expanded) to reach them. Also annotates every finding with the configurations it ' +
  'reproduces in.';

export function selectDetectors(checks?: readonly CategoryT[]): Detector[] {
  if (!checks || !checks.length) return [...DETECTORS];
  return DETECTORS.filter((d) => checks.includes(d.category));
}
