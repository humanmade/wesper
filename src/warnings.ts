import type { ContextWarning, SiteContext } from './types.js';

export function allWarnings(context: SiteContext): ContextWarning[] {
  return [...context.warnings, ...(context.bindings.warnings ?? [])];
}

export function actionableWarnings(warnings: ContextWarning[]): ContextWarning[] {
  return warnings.filter((warning) => warning.severity !== 'info');
}

export function hasActionableWarnings(warnings: ContextWarning[]): boolean {
  return actionableWarnings(warnings).length > 0;
}
