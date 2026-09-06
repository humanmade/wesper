export * from './types.js';
export { siteContextJsonSchema, siteContextSchema } from './schema.js';
export { canonicalize, sourceHash } from './canonical.js';
export {
  MAX_REDACTION_DEPTH,
  MAX_REDACTION_NODES,
  REDACTED,
  RedactionError,
  redactSecrets,
} from './redact.js';
export { orderManifestForJson, stringifyManifest } from './serialize.js';
export { parseThemeJsonSettings, type ThemeToken, type ThemeTokenKind, type ThemeTokenOrigin } from './theme.js';
export { summarize, formatSummaryMarkdown } from './summary.js';
export {
  focusContext,
  lookupBlock,
  lookupField,
  lookupNativeToken,
  nativeTokenCoverage,
  type FieldReference,
  type FoundLookupResult,
  type FocusedContext,
  type FocusOptions,
  type LookupResult,
  type LookupStatus,
  type NativeTokenReference,
  type RegistryCoverage,
  type UnresolvedLookupResult,
} from './consumer.js';
export {
  checkBindingReference,
  checkTokenReference,
  type BindingFieldSelector,
  type BindingReference,
  type CompatibilityReason,
  type CompatibilityResult,
  type CompatibilityStatus,
} from './compatibility.js';

import { ZodError } from 'zod/v4';
import { collectRest } from './collector/rest.js';
import { collectWpCli } from './collector/wpcli.js';
import { RedactionError, redactSecrets } from './redact.js';
import { siteContextSchema } from './schema.js';
import { allWarnings, coverageFor, declaredWarningsFor, strictCoverageGaps, type CollectionSurface, type CoverageStatus } from './warnings.js';
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

/**
 * Validate and redact a manifest's schema shape. This deliberately does not
 * attest provenance.sourceHash integrity; callers that require integrity must
 * compare sourceHash(result.context) with result.context.provenance.sourceHash.
 */
export function validate(manifest: unknown): ValidationResult {
  let redacted: unknown;
  try {
    redacted = redactSecrets(manifest);
  } catch (error) {
    if (error instanceof RedactionError) {
      return {
        ok: false,
        errors: [{ code: 'redaction.failed', path: '<root>', message: error.message }],
        warnings: [],
      };
    }
    throw error;
  }
  const result = siteContextSchema.safeParse(redacted);
  if (!result.success) {
    return {
      ok: false,
      errors: issuesFromZod(result.error),
      warnings: [],
    };
  }

  const context = preserveEvidence(result.data, redacted);

  return {
    ok: true,
    context,
    errors: [],
    warnings: allWarnings(context),
  };
}

/**
 * Zod defaults make a convenient typed consumer view, but an omitted raw key
 * is not evidence that a collector read an empty surface. Keep that distinction
 * in the returned document so summaries and a later serialize/validate cycle
 * retain the same collection limits. Validation deliberately preserves the
 * supplied source hash: callers use it to detect tampering rather than having
 * validation silently attest modified input.
 */
function preserveEvidence(context: SiteContext, raw: unknown): SiteContext {
  const rawManifest = recordOrUndefined(raw);
  if (!rawManifest) {
    return context;
  }

  const warnings = [...context.warnings];
  const declaredWarnings = declaredWarningsFor(context);
  for (const surface of COLLECTION_SURFACES) {
    if (surface === 'bindings' && preserveBindingChildEvidence(rawManifest, warnings, declaredWarnings)) {
      continue;
    }
    const status = rawSurfaceStatus(rawManifest, surface);
    if (status === 'complete' || hasIncompleteSurfaceWarning(declaredWarnings, surface)) {
      continue;
    }
    warnings.push({
      code: status === 'partial' ? `${surface}.invalid_evidence` : `${surface}.absent_evidence`,
      severity: 'warning',
      surface,
      message: status === 'partial'
        ? `The manifest contains incomplete ${surface} evidence; defaults were not treated as a successful empty read.`
        : `The manifest omits ${surface} evidence; the surface is unavailable rather than empty.`,
      coverage: status,
    });
  }

  const withWarnings: SiteContext = {
    ...context,
    warnings,
  };
  const partial = withWarnings.provenance.partial || coverageFor(withWarnings).some((item) => item.status !== 'complete');
  if (warnings.length === context.warnings.length && partial === context.provenance.partial) {
    return context;
  }

  return {
    ...withWarnings,
    provenance: {
      ...withWarnings.provenance,
      partial,
    },
  };
}

/**
 * Sources and supported attributes are independently collected binding
 * registries. When bindings are explicitly available, preserve a defaulted
 * child as partial evidence without weakening the sibling registry.
 */
function preserveBindingChildEvidence(
  raw: Record<string, unknown>,
  warnings: SiteContext['warnings'],
  declaredWarnings: SiteContext['warnings'],
): boolean {
  const bindings = recordOrUndefined(raw.bindings);
  if (!bindings || bindings.available !== true) {
    return false;
  }

  for (const [child, complete] of [
    ['sources', bindingSourceArray(bindings.sources)],
    ['supportedAttributes', stringArrayMap(bindings.supportedAttributes)],
  ] as const) {
    const surface = `bindings.${child}`;
    if (complete || hasIncompleteSurfaceWarning(declaredWarnings, surface)) {
      continue;
    }
    warnings.push({
      code: `${surface}.invalid_evidence`,
      severity: 'warning',
      surface,
      message: `The manifest contains incomplete ${surface} evidence; defaults were not treated as a successful empty read.`,
      coverage: 'partial',
    });
  }

  return true;
}

const COLLECTION_SURFACES: readonly CollectionSurface[] = [
  'site',
  'wordpress',
  'theme',
  'plugins',
  'blocks',
  'bindings',
  'contentModel',
  'patterns',
  'media',
];

function rawSurfaceStatus(raw: Record<string, unknown>, surface: CollectionSurface): CoverageStatus {
  if (!hasOwn(raw, surface)) {
    return 'unavailable';
  }

  switch (surface) {
    case 'site':
    case 'wordpress':
      return recordOrUndefined(raw[surface]) ? 'complete' : 'partial';
    case 'theme':
      return themeEvidence(raw.theme) ? 'complete' : 'partial';
    case 'plugins':
      return recordArray(raw.plugins) ? 'complete' : 'partial';
    case 'blocks':
      return recordWithRecordArray(raw.blocks, 'types') ? 'complete' : 'partial';
    case 'bindings':
      return bindingEvidence(raw.bindings) ? 'complete' : 'partial';
    case 'contentModel':
      return contentModelEvidence(raw.contentModel) ? 'complete' : 'partial';
    case 'patterns':
      return recordWithRecordArray(raw.patterns, 'items') ? 'complete' : 'partial';
    case 'media':
      return recordWithRecordArray(raw.media, 'imageSizes') ? 'complete' : 'partial';
  }
}

function bindingEvidence(value: unknown): boolean {
  const bindings = recordOrUndefined(value);
  if (!bindings || typeof bindings.available !== 'boolean') {
    return false;
  }
  // `available: false` is an explicit report that core bindings are unavailable,
  // which differs from an omitted binding discovery surface.
  if (!bindings.available) {
    return true;
  }
  return (
    bindingSourceArray(bindings.sources) &&
    stringArrayMap(bindings.supportedAttributes)
  );
}

function contentModelEvidence(value: unknown): boolean {
  const contentModel = recordWithRecordArray(value, 'postTypes');
  const postTypes = contentModel?.postTypes;
  return Boolean(postTypes && postTypes.every((postType) => {
    const record = recordOrUndefined(postType);
    return record && recordArray(record.fields);
  }));
}

function themeEvidence(value: unknown): boolean {
  const theme = recordOrUndefined(value);
  return Boolean(theme && (hasOwn(theme, 'settings') || nativeTokenRegistry(theme.tokens) || tokenCollections(theme.tokens)));
}

/** An explicit presets array, including [], is complete native-token evidence. */
function nativeTokenRegistry(value: unknown): boolean {
  const tokens = recordOrUndefined(value);
  return Boolean(tokens && recordArray(tokens.presets));
}

function tokenCollections(value: unknown): boolean {
  const tokens = recordOrUndefined(value);
  return Boolean(
    tokens &&
      recordArray(tokens.colors) &&
      recordArray(tokens.spacing) &&
      recordArray(tokens.typography),
  );
}

function recordWithRecordArray(value: unknown, arrayKey: string): Record<string, Array<Record<string, unknown>>> | undefined {
  const record = recordOrUndefined(value);
  return record && recordArray(record[arrayKey]) ? record as Record<string, Array<Record<string, unknown>>> : undefined;
}

function recordArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((item) => recordOrUndefined(item) !== undefined);
}

function bindingSourceArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((source) => {
    const record = recordOrUndefined(source);
    return Boolean(
      record &&
        typeof record.name === 'string' &&
        record.name.length > 0 &&
        hasOwn(record, 'usesContext') &&
        Array.isArray(record.usesContext) &&
        record.usesContext.every((item) => typeof item === 'string'),
    );
  });
}

function stringArrayMap(value: unknown): boolean {
  const record = recordOrUndefined(value);
  return Boolean(record && Object.values(record).every((item) => Array.isArray(item) && item.every((entry) => typeof entry === 'string')));
}

function hasIncompleteSurfaceWarning(warnings: readonly { surface: string; coverage?: CoverageStatus }[], surface: string): boolean {
  return warnings.some((warning) =>
    (warning.surface === surface || warning.surface.startsWith(`${surface}.`)) && warning.coverage !== 'complete',
  );
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
    code: relationshipIssueCode(issue) ?? `schema.${issue.code}`,
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function relationshipIssueCode(issue: unknown): string | undefined {
  if (!issue || typeof issue !== 'object' || !('params' in issue)) {
    return undefined;
  }
  const params = issue.params;
  if (!params || typeof params !== 'object' || !('code' in params)) {
    return undefined;
  }
  return typeof params.code === 'string' ? params.code : undefined;
}
