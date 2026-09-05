import { canonicalize, sourceHash } from '../canonical.js';
import { redactSecrets } from '../redact.js';
import { siteContextSchema } from '../schema.js';
import { parseThemeJsonSettings, themeWarnings } from '../theme.js';
import { coverageFor } from '../warnings.js';
import { CONTEXT_VERSION, SCHEMA_URL, type ContextWarning, type SiteContext } from '../types.js';

export const COLLECTOR_VERSION = '0.1.0';

export function normalizeCollectorOutput(
  raw: Record<string, unknown>,
  opts: { collector: 'wp-cli' | 'rest'; collectorVersion: string },
): SiteContext {
  // Redact before deriving either hash. This also makes every subsequent
  // normalization step operate on the exact content we may return.
  const redactedRaw = record(withoutUndefined(redactSecrets(raw)));
  const warnings = warningArray(redactedRaw.warnings);
  const themeRaw = themeSection(redactedRaw);
  if (themeRaw) warnings.push(...themeWarnings(themeRaw.settings));

  const site = recordOrUndefined(redactedRaw.site);
  if (!site) {
    warnings.push({
      code: 'site.unavailable',
      severity: 'warning',
      surface: 'site',
      message: 'Site metadata was not returned by the collector.',
      coverage: 'unavailable',
    });
  }

  const collected: Record<string, unknown> = {
    $schema: SCHEMA_URL,
    contextVersion: CONTEXT_VERSION,
    // The required `site` envelope is retained, but an absent raw value is
    // warned about rather than being mistaken for successfully read emptiness.
    site: site ?? {},
    provenance: {
      collectedAt: new Date().toISOString(),
      collector: opts.collector,
      collectorVersion: opts.collectorVersion,
      sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    partial: false,
      ...collectorMetrics(redactedRaw.provenance),
    },
    warnings,
  };
  const wordpress = recordOrUndefined(redactedRaw.wordpress);
  warnIfMalformed(warnings, redactedRaw, 'wordpress', Boolean(wordpress));
  if (wordpress) {
    collected.wordpress = wordpress;
  }
  warnIfMalformed(warnings, redactedRaw, 'theme', Boolean(themeRaw));
  if (themeRaw) {
    const settings = themeRaw.settings;
    const settingsAvailable = settings !== undefined && !Array.isArray(settings) && settings !== null && typeof settings === 'object';
    const { fontSizeValues: _fontSizeValues, ...themeEvidence } = themeRaw;
    collected.theme = {
      ...themeEvidence,
      // REST global-styles exposes the user-customization layer, not the fully merged
      // theme.json settings WP-CLI reads via wp_get_global_settings(); stamp the origin honestly.
      ...(settingsAvailable ? { settingsOrigin: opts.collector === 'rest' ? 'custom' : 'merged' } : {}),
      ...(settingsAvailable ? { themeJsonHash: sourceHash({ settings }) } : {}),
      ...(settingsAvailable ? { tokens: parseThemeJsonSettings(settings, themeRaw.fontSizeValues) } : {}),
      ...(settingsAvailable ? { settings } : {}),
    };
  }
  const plugins = redactedRaw.plugins;
  const validPlugins = recordArray(plugins);
  warnIfMalformed(warnings, redactedRaw, 'plugins', validPlugins);
  if (validPlugins) {
    collected.plugins = sortPlugins(plugins);
  }
  const blocks = recordWithRecordArray(redactedRaw, 'blocks', 'types');
  warnIfMalformed(warnings, redactedRaw, 'blocks', Boolean(blocks));
  if (blocks) {
    collected.blocks = {
      types: sortByName(array(blocks.types)).map((block) => ({
        ...block,
        attributes: emptyArrayMap(block.attributes),
        supports: emptyArrayMap(block.supports),
      })),
    };
  }
  const bindingsRaw = bindingSection(redactedRaw);
  warnIfMalformed(warnings, redactedRaw, 'bindings', Boolean(bindingsRaw));
  if (bindingsRaw) {
    collected.bindings = {
      available: bindingsRaw.available,
      sources: sortBindingSources(array(bindingsRaw.sources)),
      supportedAttributes: sortSupportedAttributes(record(bindingsRaw.supportedAttributes)),
      warnings: sortWarnings(warningArray(bindingsRaw.warnings)),
    };
  }
  const contentModel = recordWithRecordArray(redactedRaw, 'contentModel', 'postTypes');
  const completeContentModel = contentModel && hasCompletePostTypes(contentModel.postTypes) ? contentModel : undefined;
  warnIfMalformed(warnings, redactedRaw, 'contentModel', Boolean(completeContentModel));
  if (completeContentModel) {
    collected.contentModel = {
      postTypes: sortPostTypes(array(completeContentModel.postTypes)),
    };
  }
  const patterns = recordWithRecordArray(redactedRaw, 'patterns', 'items');
  warnIfMalformed(warnings, redactedRaw, 'patterns', Boolean(patterns));
  if (patterns) {
    collected.patterns = {
      items: sortPatterns(array(patterns.items)),
    };
  }
  const media = recordWithRecordArray(redactedRaw, 'media', 'imageSizes');
  warnIfMalformed(warnings, redactedRaw, 'media', Boolean(media));
  if (media) {
    collected.media = {
      ...media,
      imageSizes: sortByName(array(media.imageSizes)),
    };
  }

  // Coverage derives from explicit observed surfaces and evidence-gap warnings,
  // never from severity. In particular, informational REST gaps still make the
  // manifest partial and are considered by strict collection.
  materializeOmittedEvidence(warnings, collected);
  collected.warnings = sortWarnings(warnings);
  const normalizedEvidence = siteContextSchema.parse(withoutUndefined(collected));
  (collected.provenance as Record<string, unknown>).partial = coverageFor(normalizedEvidence).some(
    (coverage) => coverage.status !== 'complete',
  );

  // Defaults are part of the returned document, so materialize and validate them
  // before hashing. The final redaction pass is intentional defense in depth for
  // values synthesized during normalization.
  const normalized = siteContextSchema.parse(withoutUndefined(collected));
  const redacted = siteContextSchema.parse(redactSecrets(normalized));
  return {
    ...redacted,
    provenance: {
      ...redacted.provenance,
      sourceHash: sourceHash(redacted),
    },
  };
}

function collectorMetrics(value: unknown): Record<string, unknown> {
  const provenance = recordOrUndefined(value);
  const metrics = provenance && recordOrUndefined(provenance.collectionMetrics);
  return metrics ? { collectionMetrics: metrics } : {};
}

function warningArray(value: unknown): ContextWarning[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((warning): warning is ContextWarning => {
    return Boolean(
      warning &&
        typeof warning === 'object' &&
        typeof (warning as ContextWarning).code === 'string' &&
        typeof (warning as ContextWarning).severity === 'string' &&
        typeof (warning as ContextWarning).message === 'string' &&
        typeof (warning as ContextWarning).surface === 'string',
    );
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * A missing collection key is unknown, rather than an empty result. Collectors
 * express a successful empty read with an explicit key such as `{ types: [] }`.
 */
function completeRecordSection(
  raw: Record<string, unknown>,
  section: string,
  requiredKeys: readonly string[],
): Record<string, unknown> | undefined {
  const value = recordOrUndefined(raw[section]);
  return value && requiredKeys.every((key) => hasOwn(value, key)) ? value : undefined;
}

function themeSection(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = recordOrUndefined(raw.theme);
  const evidenceKeys = ['settings', 'stylesheet', 'template', 'name', 'version', 'isBlockTheme'];
  return value && evidenceKeys.some((key) => hasOwn(value, key)) ? value : undefined;
}

function recordWithRecordArray(
  raw: Record<string, unknown>,
  section: string,
  arrayKey: string,
): Record<string, unknown> | undefined {
  const value = recordOrUndefined(raw[section]);
  return value && recordArray(value[arrayKey]) ? value : undefined;
}

function bindingSection(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = completeRecordSection(raw, 'bindings', ['available', 'sources', 'supportedAttributes']);
  const supportedAttributes = value && emptyArrayMap(value.supportedAttributes);
  return value &&
    typeof value.available === 'boolean' &&
    bindingSourceArray(value.sources) &&
    stringArrayMap(supportedAttributes)
    ? { ...value, supportedAttributes }
    : undefined;
}

/**
 * PHP's json_encode serializes an empty array as `[]`. At these known
 * dictionary boundaries only, retain an explicit empty transport value as an
 * empty object map. Missing values and non-empty arrays remain invalid.
 */
function emptyArrayMap(value: unknown): unknown {
  return Array.isArray(value) && value.length === 0 ? {} : value;
}

function hasCompletePostTypes(value: unknown): boolean {
  return Array.isArray(value) && value.every((postType) => {
    const record = recordOrUndefined(postType);
    return record && recordArray(record.fields);
  });
}

function recordArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((item) => recordOrUndefined(item) !== undefined);
}

/**
 * Binding-source defaults distinguish a read empty/null value from an omitted
 * value, so validate these keys before Zod has a chance to apply defaults.
 */
function bindingSourceArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((source) => {
    const record = recordOrUndefined(source);
    return Boolean(
      record &&
        typeof record.name === 'string' &&
        record.name.length > 0 &&
        hasOwn(record, 'usesContext') &&
        Array.isArray(record.usesContext) &&
        record.usesContext.every((item) => typeof item === 'string') &&
        (!hasOwn(record, 'argsSchema') || isJsonValue(record.argsSchema)) &&
        (!hasOwn(record, 'label') || record.label === null || typeof record.label === 'string'),
    );
  });
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  const object = recordOrUndefined(value);
  return object !== undefined && Object.values(object).every(isJsonValue);
}

function stringArrayMap(value: unknown): value is Record<string, string[]> {
  const record = recordOrUndefined(value);
  return record !== undefined && Object.values(record).every(
    (entry) => Array.isArray(entry) && entry.every((item) => typeof item === 'string'),
  );
}

function warnIfMalformed(
  warnings: ContextWarning[],
  raw: Record<string, unknown>,
  surface: string,
  valid: boolean,
): void {
  if (!valid && hasOwn(raw, surface)) {
    warnings.push({
      code: `${surface}.invalid_evidence`,
      severity: 'warning',
      surface,
      message: `The collector returned incomplete ${surface} evidence; the surface was omitted rather than normalized as empty.`,
      coverage: 'partial',
    });
  }
}

function materializeOmittedEvidence(warnings: ContextWarning[], collected: Record<string, unknown>): void {
  for (const surface of COLLECTION_SURFACES) {
    if (collected[surface] !== undefined || hasSurfaceWarning(warnings, surface)) {
      continue;
    }
    warnings.push({
      code: `${surface}.absent_evidence`,
      severity: 'warning',
      surface,
      message: `The collector omitted ${surface} evidence; the surface is unavailable rather than empty.`,
      coverage: 'unavailable',
    });
  }
}

const COLLECTION_SURFACES = [
  'site',
  'wordpress',
  'theme',
  'plugins',
  'blocks',
  'bindings',
  'contentModel',
  'patterns',
  'media',
] as const;

function hasSurfaceWarning(warnings: ContextWarning[], surface: string): boolean {
  return warnings.some((warning) => warning.surface === surface || warning.surface.startsWith(`${surface}.`));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function array(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? (value.filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>>)
    : [];
}

function sortByName(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return sortByFields(items, ['name', 'key']);
}

function sortPlugins(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return sortByFields(items, ['slug', 'name']);
}

function sortBindingSources(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return sortByName(items).map((source) => ({
    ...source,
    usesContext: sortStrings(source.usesContext),
  }));
}

function sortPostTypes(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return sortByName(items).map((postType) => ({
    ...postType,
    fields: sortByName(array(postType.fields)),
    taxonomies: sortStrings(postType.taxonomies),
  }));
}

function sortSupportedAttributes(value: Record<string, unknown>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([blockName, attributes]) => [
        blockName,
        sortStrings(attributes),
      ]),
  );
}

function sortPatterns(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return sortByName(items).map((pattern) => sortSetProperties(pattern, ['categories', 'blockTypes', 'postTypes']));
}

function sortSetProperties(item: Record<string, unknown>, properties: string[]): Record<string, unknown> {
  const sorted = { ...item };
  for (const property of properties) {
    if (Array.isArray(item[property])) {
      sorted[property] = sortStrings(item[property]);
    }
  }
  return sorted;
}

function sortWarnings(warnings: ContextWarning[]): ContextWarning[] {
  return [...warnings].sort((left, right) => {
    for (const field of ['surface', 'code', 'severity', 'message'] as const) {
      const comparison = compareStrings(left[field], right[field]);
      if (comparison !== 0) {
        return comparison;
      }
    }
    return 0;
  });
}

function sortByFields(items: Array<Record<string, unknown>>, fields: string[]): Array<Record<string, unknown>> {
  return [...items].sort((left, right) => {
    for (const field of fields) {
      const comparison = compareStrings(String(left[field] ?? ''), String(right[field] ?? ''));
      if (comparison !== 0) {
        return comparison;
      }
    }
    return compareStrings(canonicalize(left), canonicalize(right));
  });
}

function sortStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).sort(compareStrings) : [];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : withoutUndefined(item)));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .map(([key, nested]) => [key, withoutUndefined(nested)]),
  );
}
