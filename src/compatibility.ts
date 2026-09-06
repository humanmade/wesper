import {
  lookupBlock,
  lookupField,
  lookupNativeToken,
  nativeTokenCoverage,
  type FieldReference,
  type NativeTokenReference,
} from './consumer.js';
import type { ThemeToken } from './theme.js';
import type { BindingField, BindingSource, ContextWarning, SiteContext } from './types.js';
import { declaredWarningsFor, type CoverageStatus } from './warnings.js';

/** The conclusion supported by the supplied manifest snapshot. */
export type CompatibilityStatus = 'compatible' | 'incompatible' | 'unknown';

/** A source-qualified binding join. The field selector deliberately reuses lookup semantics. */
export interface BindingReference {
  block: string;
  attribute: string;
  source: string;
  /** The source is deliberately top-level, so a selector cannot contradict it. */
  field: BindingFieldSelector;
}

/** A field selector for a binding reference, without FieldReference's optional source. */
export type BindingFieldSelector = {
  postType: string;
} & (
  { key: string; name?: string }
  | { key?: never; name: string }
);

/** Auditable evidence for one prerequisite of a compatibility conclusion. */
export interface CompatibilityReason {
  code: string;
  message: string;
  coverage: CoverageStatus;
  warnings: ContextWarning[];
  /** Stable manifest paths using record identifiers rather than array indexes. */
  evidence: string[];
}

export interface CompatibilityResult {
  status: CompatibilityStatus;
  /** Copied from provenance; compatibility does not verify this hash. */
  sourceManifestHash: string;
  reasons: CompatibilityReason[];
  /** Deterministic, de-duplicated union of reason evidence. */
  evidence: string[];
  /** Present for a compatible native-token check; references are collector-reported strings. */
  token?: ThemeToken;
  /** Present for a compatible binding check; no source arguments are inferred or rewritten. */
  binding?: { source: BindingSource; field: BindingField };
}

/**
 * Check a native WordPress preset reference. This is only a manifest-reference
 * check: it does not establish CSS rendering or semantic suitability.
 */
export function checkTokenReference(context: SiteContext, reference: NativeTokenReference): CompatibilityResult {
  const lookup = lookupNativeToken(context, reference);
  const coverage = nativeTokenCoverage(context);
  const registry = 'theme.tokens.presets';
  const identity = `${reference.kind}:${reference.slug}`;
  const matches = (context.theme?.tokens?.presets ?? []).filter(
    (token) => token.kind === reference.kind && token.slug === reference.slug,
  );
  const requestedEvidence = tokenRequestedEvidence(reference);
  let reason: CompatibilityReason;

  if (matches.length > 1) {
    reason = makeReason('token.ambiguous', `More than one native token reports "${identity}".`, coverage, [registry, requestedEvidence]);
    return result(context, 'unknown', [reason]);
  }
  if (lookup.status === 'found') {
    const evidence = tokenRecordEvidence(lookup.value.id, reference);
    reason = makeReason('token.found', `Native token "${identity}" is reported.`, coverage, [registry, evidence]);
    return result(context, 'compatible', [reason], { token: lookup.value });
  }
  reason = makeReason(
    lookup.status === 'absent' ? 'token.absent' : 'token.unknown',
    lookup.status === 'absent'
      ? `Native token "${identity}" is not reported by the complete native-token registry.`
      : `Native token "${identity}" cannot be established because native-token coverage is ${coverage.coverage}.`,
    coverage,
    [registry, requestedEvidence],
  );
  return result(context, lookup.status === 'absent' ? 'incompatible' : 'unknown', [reason]);
}

/**
 * Check the explicit block/attribute/source/field binding contract. It neither
 * infers a binding nor generates source arguments: compatible field args are
 * reported exactly as they appeared in the manifest through the evidence path.
 */
export function checkBindingReference(context: SiteContext, reference: BindingReference): CompatibilityResult {
  const reasons: Array<{ status: CompatibilityStatus; reason: CompatibilityReason }> = [];
  const block = lookupBlock(context, reference.block);
  reasons.push(lookupReason('block', block.status, `blocks.types.${reference.block}`, block.coverage, block.warnings));

  const attributes = bindingEvidence(context, 'bindings.supportedAttributes');
  const supported = context.bindings?.supportedAttributes[reference.block]?.includes(reference.attribute) === true;
  reasons.push(membershipReason(supported, 'binding_attribute', `bindings.supportedAttributes.${reference.block}.${reference.attribute}`, attributes));

  const sources = bindingEvidence(context, 'bindings.sources');
  const source = context.bindings?.sources.find((candidate) => candidate.name === reference.source);
  const hasSource = source !== undefined;
  reasons.push(membershipReason(hasSource, 'binding_source', `bindings.sources.${reference.source}`, sources));

  const nestedSource = (reference.field as FieldReference).source;
  const fieldReference: FieldReference = reference.field.key !== undefined
    ? { ...reference.field, source: reference.source }
    : { ...reference.field, source: reference.source };
  const field = lookupField(context, fieldReference);
  const fieldIdentity = fieldEvidencePath(reference);
  if (nestedSource !== undefined && nestedSource !== reference.source) {
    reasons.push({
      status: 'unknown',
      reason: makeReason('field.source_conflict', `Field selector source "${nestedSource}" conflicts with binding source "${reference.source}".`, { coverage: field.coverage, warnings: field.warnings }, [fieldIdentity]),
    });
  } else if (field.status === 'found' && field.value.bindable === false && attributes.coverage !== 'unavailable' && sources.coverage !== 'unavailable') {
    reasons.push({ status: 'incompatible', reason: makeReason('field.not_bindable', `Field "${fieldIdentity}" is explicitly reported as not bindable.`, { coverage: field.coverage, warnings: field.warnings }, [fieldIdentity]) });
  } else {
    reasons.push(lookupReason('field', field.status, fieldIdentity, field.coverage, field.warnings));
  }

  const status = reasons.some((item) => item.status === 'incompatible')
    ? 'incompatible'
    : reasons.some((item) => item.status === 'unknown')
      ? 'unknown'
      : 'compatible';
  return result(context, status, reasons.map((item) => item.reason), status === 'compatible' && source && field.status === 'found'
    ? { binding: { source, field: field.value } }
    : undefined);
}

function lookupReason(kind: 'block' | 'field', status: 'found' | 'absent' | 'unknown', evidence: string, coverage: CoverageStatus, warnings: ContextWarning[]): { status: CompatibilityStatus; reason: CompatibilityReason } {
  const compatible = status === 'found';
  const incompatible = status === 'absent';
  const label = kind === 'block' ? 'Block' : 'Field';
  return {
    status: compatible ? 'compatible' : incompatible ? 'incompatible' : 'unknown',
    reason: makeReason(
      `${kind}.${compatible ? 'found' : incompatible ? 'absent' : 'unknown'}`,
      compatible ? `${label} "${evidence}" is reported.` : incompatible ? `${label} "${evidence}" is not reported by complete evidence.` : `${label} "${evidence}" cannot be established because coverage is ${coverage}.`,
      { coverage, warnings },
      [evidence],
    ),
  };
}

function membershipReason(found: boolean, kind: 'binding_attribute' | 'binding_source', evidence: string, coverage: { coverage: CoverageStatus; warnings: ContextWarning[] }): { status: CompatibilityStatus; reason: CompatibilityReason } {
  if (coverage.coverage === 'unavailable') {
    return {
      status: 'unknown',
      reason: makeReason(
        `${kind}.unknown`,
        `Binding evidence "${evidence}" cannot be established because coverage is unavailable.`,
        coverage,
        [evidence],
      ),
    };
  }
  const absence = coverage.coverage === 'complete' ? 'incompatible' : 'unknown';
  const status: CompatibilityStatus = found ? 'compatible' : absence;
  return {
    status,
    reason: makeReason(
      `${kind}.${found ? 'found' : status === 'incompatible' ? 'absent' : 'unknown'}`,
      found ? `Binding evidence "${evidence}" is reported.` : status === 'incompatible' ? `Binding evidence "${evidence}" is not reported by complete evidence.` : `Binding evidence "${evidence}" cannot be established because coverage is ${coverage.coverage}.`,
      coverage,
      [evidence],
    ),
  };
}

function bindingEvidence(context: SiteContext, path: 'bindings.sources' | 'bindings.supportedAttributes'): { coverage: CoverageStatus; warnings: ContextWarning[] } {
  const bindings = context.bindings;
  const warnings = declaredWarningsFor(context).filter((warning) => warning.surface === 'bindings' || warning.surface.startsWith(`${path}.`) || warning.surface === path);
  const directUnavailable = bindings?.available === false || !bindings || warnings.some((warning) => warning.surface === path && warning.coverage === 'unavailable');
  const incomplete = warnings.some((warning) => warning.coverage === undefined || warning.coverage === 'partial' || warning.coverage === 'unavailable');
  return {
    // Do not inherit aggregate bindings coverage: a warning about supported
    // attributes must not weaken an independently collected source registry,
    // or vice versa. Root bindings warnings are shared deliberately.
    coverage: directUnavailable ? 'unavailable' : incomplete ? 'partial' : 'complete',
    warnings,
  };
}

function fieldEvidencePath(reference: BindingReference): string {
  const selector = [
    reference.field.key !== undefined ? `key:${reference.field.key}` : undefined,
    reference.field.name !== undefined ? `name:${reference.field.name}` : undefined,
  ].filter((part): part is string => part !== undefined).join('.');
  return `contentModel.postTypes.${reference.field.postType}.fields.${reference.source}.${selector}`;
}

function tokenRequestedEvidence(reference: NativeTokenReference): string {
  return `theme.tokens.presets.kind:${reference.kind}.slug:${reference.slug}`;
}

function tokenRecordEvidence(id: string, reference: NativeTokenReference): string {
  return `theme.tokens.presets.id:${id}.kind:${reference.kind}.slug:${reference.slug}`;
}

function makeReason(code: string, message: string, evidence: { coverage: CoverageStatus; warnings: ContextWarning[] }, paths: string[]): CompatibilityReason {
  return { code, message, coverage: evidence.coverage, warnings: [...evidence.warnings], evidence: [...paths] };
}

function result(context: SiteContext, status: CompatibilityStatus, reasons: CompatibilityReason[], payload?: Pick<CompatibilityResult, 'token' | 'binding'>, evidence?: string[]): CompatibilityResult {
  return {
    status,
    sourceManifestHash: context.provenance.sourceHash,
    reasons,
    evidence: evidence ?? [...new Set(reasons.flatMap((reason) => reason.evidence))],
    ...payload,
  };
}
