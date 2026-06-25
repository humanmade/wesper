export * from './types.js';
export { siteContextJsonSchema, siteContextSchema } from './schema.js';
export { canonicalize, sourceHash } from './canonical.js';
export { redactSecrets } from './redact.js';
export { parseThemeJsonSettings } from './theme.js';
export { summarize, formatSummaryMarkdown } from './summary.js';

import { ZodError } from 'zod';
import { collectWpCli } from './collector/wpcli.js';
import { redactSecrets } from './redact.js';
import { siteContextSchema } from './schema.js';
import { actionableWarnings, allWarnings } from './warnings.js';
import type { CollectOptions, SiteContext, ValidationIssue, ValidationResult } from './types.js';

export async function collect(options: CollectOptions): Promise<SiteContext> {
  const collector = options.collector ?? 'wp-cli';
  switch (collector) {
    case 'wp-cli':
      return enforceStrict(await collectWpCli({ ...options, collector }), options);
    case 'fixture':
      throw new Error('Fixture collection is represented by validate() on a manifest file.');
    default:
      throw new Error(`Unsupported collector: ${String(collector)}`);
  }
}

export function validate(manifest: unknown): ValidationResult {
  const redacted = redactSecrets(manifest);
  const result = siteContextSchema.safeParse(redacted);
  if (!result.success) {
    return {
      ok: false,
      errors: issuesFromZod(result.error),
      warnings: [],
    };
  }

  return {
    ok: true,
    context: result.data,
    errors: [],
    warnings: allWarnings(result.data),
  };
}

function enforceStrict(context: SiteContext, options: CollectOptions): SiteContext {
  const warnings = actionableWarnings(allWarnings(context));
  if (options.strict && (context.provenance.partial || warnings.length > 0)) {
    const surfaces = warnings.map((warning) => warning.surface).join(', ') || 'provenance.partial';
    throw new Error(`Strict collection failed because the manifest is partial or has actionable warnings: ${surfaces}`);
  }
  return context;
}

function issuesFromZod(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}
