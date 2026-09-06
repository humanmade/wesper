import type { ThemeToken, ThemeTokenKind } from './theme.js';
import type { BindingField, BlockType, ContextWarning, SiteContext } from './types.js';
import { coverageFor, declaredWarningsFor, type CoverageStatus } from './warnings.js';

/** Whether a lookup was established by the manifest, disproved by complete evidence, or remains uncollected. */
export type LookupStatus = 'found' | 'absent' | 'unknown';

export type LookupResult<T> = FoundLookupResult<T> | UnresolvedLookupResult;

export interface FoundLookupResult<T> {
  status: 'found';
  /** The exact record reported by the manifest. */
  value: T;
  /** Evidence coverage for the registry queried by this lookup. */
  coverage: CoverageStatus;
  warnings: ContextWarning[];
  sourceManifestHash: string;
}

export interface UnresolvedLookupResult {
  status: 'absent' | 'unknown';
  /** Evidence coverage for the registry queried by this lookup. */
  coverage: CoverageStatus;
  warnings: ContextWarning[];
  sourceManifestHash: string;
}

/** Coverage and warnings for a registry queried by a consumer helper. */
export interface RegistryCoverage {
  /** Manifest surface whose collection establishes this registry's coverage. */
  surface: 'blocks' | 'contentModel' | 'theme.tokens';
  coverage: CoverageStatus;
  warnings: ContextWarning[];
}

export interface NativeTokenReference {
  kind: ThemeTokenKind;
  slug: string;
}

export type FieldReference = {
  postType: string;
  source?: string;
} & (
  /** Match a field's stable key when it is reported. */
  { key: string; name?: string }
  /** Match a field by its reported name when no stable key is available. */
  | { key?: never; name: string }
);

export interface FocusOptions {
  postTypes?: readonly string[];
  blocks?: readonly string[];
  tokenKinds?: readonly ThemeTokenKind[];
}

/**
 * A deliberately non-manifest projection. `sourceManifestHash` identifies its
 * parent only; it is not a hash of this view.
 */
export interface FocusedContext {
  kind: 'wesper.focused-context';
  derived: true;
  sourceManifestHash: string;
  selection: {
    postTypes: string[];
    blocks: string[];
    tokenKinds: ThemeTokenKind[];
  };
  coverage: {
    postTypes: CoverageStatus;
    blocks: CoverageStatus;
    nativeTokens: CoverageStatus;
  };
  warnings: ContextWarning[];
  postTypes: Array<{ name: string; fields: BindingField[] }>;
  blocks: BlockType[];
  tokens: ThemeToken[];
}

/** Look up an emitted native WordPress preset without reimplementing its reference syntax. */
export function lookupNativeToken(context: SiteContext, reference: NativeTokenReference): LookupResult<ThemeToken> {
  const evidence = nativeTokenCoverage(context);
  const value = nativeTokens(context).find((token) => token.kind === reference.kind && token.slug === reference.slug);
  return lookupResult(context, evidence, value);
}

/** Look up a registered block type. */
export function lookupBlock(context: SiteContext, name: string): LookupResult<BlockType> {
  const evidence = surfaceEvidence(context, 'blocks');
  const value = context.blocks?.types.find((block) => block.name === name);
  return lookupResult(context, evidence, value);
}

/** Look up a reported field, retaining its collector-provided binding arguments verbatim. */
export function lookupField(context: SiteContext, reference: FieldReference): LookupResult<BindingField> {
  if (reference.key === undefined && reference.name === undefined) {
    throw new TypeError('A field lookup requires a key or name.');
  }
  const evidence = surfaceEvidence(context, 'contentModel');
  const fields = context.contentModel?.postTypes.find((postType) => postType.name === reference.postType)?.fields ?? [];
  const value = fields.find((field) =>
    (reference.key === undefined || field.key === reference.key) &&
    (reference.name === undefined || field.name === reference.name) &&
    (reference.source === undefined || field.source === reference.source),
  );
  return lookupResult(context, evidence, value);
}

/**
 * Select a small, deterministic task view. This is intentionally not a
 * `SiteContext`: no source hash is asserted for data derived from a manifest.
 */
export function focusContext(context: SiteContext, options: FocusOptions = {}): FocusedContext {
  const selection = {
    postTypes: sortedUnique(options.postTypes ?? []),
    blocks: sortedUnique(options.blocks ?? []),
    tokenKinds: sortedUnique(options.tokenKinds ?? []) as ThemeTokenKind[],
  };
  const postTypes = (context.contentModel?.postTypes ?? [])
    .filter((postType) => selection.postTypes.includes(postType.name))
    .map((postType) => ({ ...postType, fields: [...postType.fields].sort(compareFields) }))
    .sort((left, right) => compare(left.name, right.name));
  const blocks = (context.blocks?.types ?? [])
    .filter((block) => selection.blocks.includes(block.name))
    .slice()
    .sort((left, right) => compare(left.name, right.name));
  const tokens = nativeTokens(context)
    .filter((token) => selection.tokenKinds.includes(token.kind))
    .slice()
    .sort(compareTokens);
  const warnings = relevantWarnings(context, selection);

  return {
    kind: 'wesper.focused-context',
    derived: true,
    sourceManifestHash: context.provenance.sourceHash,
    selection,
    coverage: {
      postTypes: surfaceEvidence(context, 'contentModel').coverage,
      blocks: surfaceEvidence(context, 'blocks').coverage,
      nativeTokens: nativeTokenCoverage(context).coverage,
    },
    warnings,
    postTypes,
    blocks,
    tokens,
  };
}

function lookupResult<T>(context: SiteContext, evidence: RegistryCoverage, value: T | undefined): LookupResult<T> {
  if (value !== undefined) {
    return { status: 'found', value, coverage: evidence.coverage, warnings: evidence.warnings, sourceManifestHash: context.provenance.sourceHash };
  }
  return { status: evidence.coverage === 'complete' ? 'absent' : 'unknown', coverage: evidence.coverage, warnings: evidence.warnings, sourceManifestHash: context.provenance.sourceHash };
}

function surfaceEvidence(context: SiteContext, surface: 'blocks' | 'contentModel'): RegistryCoverage {
  const result = coverageFor(context, [surface])[0];
  if (!result) throw new Error(`Coverage was not returned for ${surface}.`);
  return { surface, coverage: result.status, warnings: result.warnings };
}

/**
 * Theme settings and the native preset registry are independently collected.
 * Only an explicit `theme.tokens.presets` array attests the native registry;
 * the legacy color/spacing/typography arrays are readable data, not evidence
 * that native references were collected.
 */
export function nativeTokenCoverage(context: SiteContext): RegistryCoverage {
  const warnings = declaredWarningsFor(context).filter(isNativeTokenWarning);
  const directUnavailable = warnings.some((warning) => warning.surface === 'theme.tokens' && warning.coverage === 'unavailable');
  const incomplete = warnings.some((warning) => warning.coverage === undefined || warning.coverage === 'partial' || warning.coverage === 'unavailable');
  const observed = Array.isArray(context.theme?.tokens?.presets);
  return {
    surface: 'theme.tokens',
    coverage: directUnavailable ? 'unavailable' : incomplete ? 'partial' : observed ? 'complete' : 'unavailable',
    warnings,
  };
}

/** Theme-wide and native-registry warnings can affect token evidence; settings-only warnings cannot. */
function isNativeTokenWarning(warning: ContextWarning): boolean {
  return warning.surface === 'theme' || warning.surface === 'theme.tokens' || warning.surface.startsWith('theme.tokens.');
}

function nativeTokens(context: SiteContext): ThemeToken[] {
  return (context.theme?.tokens?.presets ?? []).filter(isThemeToken);
}

function isThemeToken(value: unknown): value is ThemeToken {
  if (!value || typeof value !== 'object') return false;
  const token = value as Partial<ThemeToken>;
  return typeof token.id === 'string' && typeof token.kind === 'string' && typeof token.slug === 'string' &&
    typeof token.value === 'string' && token.references !== undefined;
}

function relevantWarnings(context: SiteContext, selection: FocusedContext['selection']): ContextWarning[] {
  return declaredWarningsFor(context)
    .filter((warning) => warningAppliesToSelection(warning, selection))
    .slice()
    .sort((left, right) => compare(left.surface, right.surface) || compare(left.code, right.code) || compare(left.message, right.message));
}

function warningAppliesToSelection(warning: ContextWarning, selection: FocusedContext['selection']): boolean {
  if (warning.surface === 'contentModel' || warning.surface.startsWith('contentModel.')) {
    return selection.postTypes.length > 0 && scopedWarningMatches(warning.surface, 'contentModel.postTypes', selection.postTypes);
  }
  if (warning.surface === 'blocks' || warning.surface.startsWith('blocks.')) {
    return selection.blocks.length > 0 && scopedWarningMatches(warning.surface, 'blocks.types', selection.blocks);
  }
  if (isNativeTokenWarning(warning)) {
    return selection.tokenKinds.length > 0 && scopedWarningMatches(warning.surface, 'theme.tokens.presets', selection.tokenKinds);
  }
  return false;
}

/** A warning beneath a named registry applies only when that named item was selected. */
function scopedWarningMatches(surface: string, prefix: string, selected: readonly string[]): boolean {
  if (!surface.startsWith(`${prefix}.`)) return true;
  const name = surface.slice(prefix.length + 1).split('.')[0];
  return name !== undefined && selected.includes(name);
}

function sortedUnique(values: readonly string[]): string[] { return [...new Set(values)].sort(compare); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function compareTokens(left: ThemeToken, right: ThemeToken): number { return compare(left.kind, right.kind) || compare(left.slug, right.slug); }
function compareFields(left: BindingField, right: BindingField): number { return compare(left.source, right.source) || compare(left.key ?? '', right.key ?? '') || compare(left.name, right.name); }
