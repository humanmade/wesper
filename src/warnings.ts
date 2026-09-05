import type { ContextWarning, SiteContext } from './types.js';

const CONTENT_SECTIONS = ['site', 'wordpress', 'theme', 'plugins', 'blocks', 'bindings', 'contentModel', 'patterns', 'media'] as const;

/**
 * Evidence a binding consumer needs before it can safely propose bindings. Other
 * manifest sections remain useful, but are not a prerequisite for that work.
 */
export const REQUIRED_STRICT_SURFACES = ['blocks', 'bindings', 'contentModel'] as const;

export type CollectionSurface = (typeof CONTENT_SECTIONS)[number];
export type CoverageStatus = 'complete' | 'partial' | 'unavailable';

export interface SurfaceCoverage {
  surface: CollectionSurface;
  status: CoverageStatus;
  warnings: ContextWarning[];
}

export function allWarnings(context: SiteContext): ContextWarning[] {
  const declaredWarnings = declaredWarningsFor(context);
  return [...declaredWarnings, ...missingSectionWarnings(context, declaredWarnings)];
}

/**
 * Returns the raw warnings from every location in the manifest. Keep this
 * separate from synthetic validation warnings so collectors can derive coverage
 * from what they observed rather than from a warning's severity.
 */
export function declaredWarningsFor(context: SiteContext): ContextWarning[] {
  return [...context.warnings, ...(context.bindings?.warnings ?? [])];
}

/**
 * Classify each manifest surface from the evidence itself.
 *
 * `complete` includes a successfully read empty surface. A missing surface is
 * `unavailable` unless an evidence warning records a partial read. Warning
 * severity and names deliberately have no bearing on coverage: a warning must
 * declare its coverage, while an undeclared warning is conservatively partial.
 */
export function coverageFor(
  context: SiteContext,
  surfaces: readonly CollectionSurface[] = CONTENT_SECTIONS,
): SurfaceCoverage[] {
  const warnings = declaredWarningsFor(context);

  return surfaces.map((surface) => {
    const surfaceWarnings = warnings.filter((warning) => warningMatchesSurface(warning, surface));
    const observed = context[surface] !== undefined && !(surface === 'bindings' && context.bindings?.available === false);
    const directUnavailable = surfaceWarnings.some(
      (warning) => warning.surface === surface && warning.coverage === 'unavailable',
    );
    const incompleteWarning = surfaceWarnings.some(
      (warning) => warning.coverage === undefined || warning.coverage === 'partial' || warning.coverage === 'unavailable',
    );

    return {
      surface,
      status: directUnavailable || (surface === 'bindings' && context.bindings?.available === false)
        ? 'unavailable'
        : incompleteWarning
          ? 'partial'
          : !observed
            ? 'unavailable'
            : 'complete',
      warnings: surfaceWarnings,
    };
  });
}

export function strictCoverageGaps(context: SiteContext): SurfaceCoverage[] {
  return coverageFor(context, REQUIRED_STRICT_SURFACES).filter((coverage) => coverage.status !== 'complete');
}

export function actionableWarnings(warnings: ContextWarning[]): ContextWarning[] {
  return warnings.filter((warning) => warning.severity !== 'info');
}

export function hasActionableWarnings(warnings: ContextWarning[]): boolean {
  return actionableWarnings(warnings).length > 0;
}

function missingSectionWarnings(context: SiteContext, declaredWarnings: ContextWarning[]): ContextWarning[] {
  return CONTENT_SECTIONS.flatMap((section) => {
    if (context[section] !== undefined || hasSurfaceWarning(declaredWarnings, section)) {
      return [];
    }

    return [
      {
        code: 'absent_without_warning',
        severity: 'warning',
        surface: section,
        message: `Manifest section "${section}" is absent without a matching warning.`,
      },
    ];
  });
}

function hasSurfaceWarning(warnings: ContextWarning[], section: string): boolean {
  return warnings.some((warning) => warningMatchesSurface(warning, section));
}

function warningMatchesSurface(warning: ContextWarning, surface: string): boolean {
  return warning.surface === surface || warning.surface.startsWith(`${surface}.`);
}
