import type { ContextWarning, SiteContext } from './types.js';

const CONTENT_SECTIONS = ['wordpress', 'theme', 'plugins', 'blocks', 'bindings', 'contentModel', 'patterns', 'media'] as const;

export function allWarnings(context: SiteContext): ContextWarning[] {
  const declaredWarnings = [...context.warnings, ...(context.bindings?.warnings ?? [])];
  return [...declaredWarnings, ...missingSectionWarnings(context, declaredWarnings)];
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
  return warnings.some((warning) => warning.surface === section || warning.surface.startsWith(`${section}.`));
}
