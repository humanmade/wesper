export * from './types.js';
export { siteContextJsonSchema, siteContextSchema } from './schema.js';
export { canonicalize, sourceHash } from './canonical.js';
export { redactSecrets } from './redact.js';
export { orderManifestForJson, stringifyManifest } from './serialize.js';
export { parseThemeJsonSettings } from './theme.js';
export { summarize, formatSummaryMarkdown } from './summary.js';

import { ZodError } from 'zod/v4';
import { collectRest } from './collector/rest.js';
import { collectWpCli } from './collector/wpcli.js';
import { redactSecrets } from './redact.js';
import { siteContextSchema } from './schema.js';
import { allWarnings, strictCoverageGaps } from './warnings.js';
import {
  CollectionError,
  CollectionTransportError,
  StrictCollectionError,
  UsageError,
  type CollectOptions,
  type SiteContext,
  type ValidationIssue,
  type ValidationResult,
} from './types.js';

export async function collect(options: CollectOptions): Promise<SiteContext> {
  try {
    const collector = options.collector ?? 'wp-cli';
    switch (collector) {
      case 'wp-cli':
        return enforceStrict(await collectWpCli({ ...options, collector }), options);
      case 'rest':
        return enforceStrict(await collectRest({ ...options, collector }), options);
      case 'fixture':
        throw new UsageError('Fixture collection is represented by validate() on a manifest file.');
      default:
        throw new UsageError(`Unsupported collector: ${String(collector)}`);
    }
  } catch (error) {
    if (error instanceof CollectionError) {
      throw error;
    }
    throw new CollectionTransportError(`Collector failed: ${message(error)}`);
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
  const evidenceGaps = strictCoverageGaps(context);
  if (options.strict && evidenceGaps.length > 0) {
    const incomplete = evidenceGaps.map((coverage) => `${coverage.surface} (${coverage.status})`);
    throw new StrictCollectionError(`Strict collection failed because required evidence is incomplete: ${incomplete.join(', ')}.`);
  }
  return context;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issuesFromZod(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}
