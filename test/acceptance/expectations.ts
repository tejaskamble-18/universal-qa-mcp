import type { CategoryT, StatusT } from '../../src/report/schema.js';

/**
 * The defects deliberately built into fixtures/broken/*.html, written down from
 * the fixture design (see the DEFECT comments in each file). The engine never
 * sees this list or the fixtures' data-defect attributes.
 */
export interface Expectation {
  id: string;
  page: string;
  categories: CategoryT[];
  /** Selectors that must all appear among the finding's elements (or as an ancestor path of one). */
  involves: string[];
  statuses: StatusT[];
  /** Configuration keys where the defect must reproduce. */
  reproducesIn?: string[];
  /** Configuration keys where it must not be reported. */
  absentIn?: string[];
}

const V: StatusT[] = ['verified'];
const P: StatusT[] = ['potential'];

export const EXPECTED: Expectation[] = [
  { id: 'overlapping-buttons', page: 'broken/toolbar.html', categories: ['overlap'], involves: ['#btn-open', '#btn-save'], statuses: V,
    reproducesIn: ['375x812@100', '768x1024@100', '1280x800@100', '1280x800@200'] },
  { id: 'inconsistent-spacing', page: 'broken/toolbar.html', categories: ['inconsistent-spacing'], involves: ['#act-3', '#act-4'], statuses: P },
  { id: 'misaligned-card', page: 'broken/toolbar.html', categories: ['misalignment'], involves: ['#card-3'], statuses: P,
    reproducesIn: ['768x1024@100', '1280x800@100'] },

  { id: 'clipped-navigation', page: 'broken/nav.html', categories: ['clipped-target'], involves: ['#main-nav'], statuses: V,
    reproducesIn: ['375x812@100', '768x1024@100', '1280x800@200'], absentIn: ['1280x800@100'] },
  { id: 'clipped-tab-strip', page: 'broken/nav.html', categories: ['clipped-target'], involves: ['#sub-nav'], statuses: V },
  { id: 'clipped-heading', page: 'broken/nav.html', categories: ['text-clipping'], involves: ['#promo-title'], statuses: V },

  { id: 'spilling-card', page: 'broken/dashboard.html', categories: ['container-overflow'], involves: ['#card-revenue'], statuses: V },
  { id: 'spill-overlaps-next-card', page: 'broken/dashboard.html', categories: ['overlap'], involves: ['#card-revenue'], statuses: V },
  { id: 'hidden-card-button', page: 'broken/dashboard.html', categories: ['clipped-target'], involves: ['#card-users', '#btn-view-users'], statuses: V },
  { id: 'overflowing-url', page: 'broken/dashboard.html', categories: ['container-overflow'], involves: ['#long-url'], statuses: V },

  { id: 'clipped-dropdown', page: 'broken/dropdowns.html', categories: ['popup-clipping'], involves: ['#menu-a', '#panel-a'], statuses: V },
  { id: 'detached-dropdown', page: 'broken/dropdowns.html', categories: ['popup-placement'], involves: ['#menu-b', '#trigger-b'], statuses: V },

  { id: 'click-shield', page: 'broken/hidden-controls.html', categories: ['obstructed-target'], involves: ['#click-shield', '#btn-pay', '#btn-cancel'], statuses: V },
  { id: 'offscreen-control', page: 'broken/hidden-controls.html', categories: ['offscreen-target'], involves: ['#btn-help'], statuses: V },
  { id: 'covered-control', page: 'broken/hidden-controls.html', categories: ['overlap', 'obstructed-target'], involves: ['#btn-chat', '#promo-panel'], statuses: V },

  { id: 'fixed-width-banner', page: 'broken/responsive.html', categories: ['viewport-overflow'], involves: ['#hero-banner'], statuses: V,
    reproducesIn: ['375x812@100', '768x1024@100', '1280x800@200'], absentIn: ['1280x800@100'] },
  { id: 'non-wrapping-row', page: 'broken/responsive.html', categories: ['container-overflow'], involves: ['#feature-row'], statuses: V },
  { id: 'tablet-sidebar-overlap', page: 'broken/responsive.html', categories: ['overlap'], involves: ['#sidebar', '#main-copy'], statuses: V,
    reproducesIn: ['768x1024@100'], absentIn: ['375x812@100', '1280x800@100', '1280x800@200'] },
  { id: 'missing-mobile-nav', page: 'broken/responsive.html', categories: ['responsive-layout'], involves: ['#desktop-links'], statuses: P },

  { id: 'modal-too-tall', page: 'broken/modal.html', categories: ['popup-clipping'], involves: ['#modal'], statuses: V,
    reproducesIn: ['375x812@100', '1280x800@100', '1280x800@200'] },

  { id: 'clipped-button-label', page: 'broken/text.html', categories: ['text-clipping'], involves: ['#btn-clip'], statuses: V },
  { id: 'clipped-badge', page: 'broken/text.html', categories: ['text-clipping'], involves: ['#badge-label'], statuses: V },
];

export const BROKEN_PAGES = [...new Set(EXPECTED.map((e) => e.page))];
