import { sourceHash } from '../canonical.js';
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
  const warnings = warningArray(raw.warnings);
  const themeRaw = completeRecordSection(raw, 'theme', ['settings']);
  if (themeRaw) {
    const settings = themeRaw.settings;
    warnings.push(...themeWarnings(settings));
  }

  const site = recordOrUndefined(raw.site);
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
    },
    warnings,
  };
  const wordpress = recordOrUndefined(raw.wordpress);
  warnIfMalformed(warnings, raw, 'wordpress', Boolean(wordpress));
  if (wordpress) {
    collected.wordpress = wordpress;
  }
  warnIfMalformed(warnings, raw, 'theme', Boolean(themeRaw));
  if (themeRaw) {
    const settings = themeRaw.settings;
    collected.theme = {
      ...themeRaw,
      // REST global-styles exposes the user-customization layer, not the fully merged
      // theme.json settings WP-CLI reads via wp_get_global_settings(); stamp the origin honestly.
      settingsOrigin: opts.collector === 'rest' ? 'custom' : 'merged',
      themeJsonHash: settings ? sourceHash({ settings }) : undefined,
      tokens: parseThemeJsonSettings(settings),
      settings,
    };
  }
  const plugins = raw.plugins;
  const validPlugins = recordArray(plugins);
  warnIfMalformed(warnings, raw, 'plugins', validPlugins);
  if (validPlugins) {
    collected.plugins = plugins;
  }
  const blocks = recordWithRecordArray(raw, 'blocks', 'types');
  warnIfMalformed(warnings, raw, 'blocks', Boolean(blocks));
  if (blocks) {
    collected.blocks = {
      types: sortByName(array(blocks.types)),
    };
  }
  const bindingsRaw = bindingSection(raw);
  warnIfMalformed(warnings, raw, 'bindings', Boolean(bindingsRaw));
  if (bindingsRaw) {
    collected.bindings = {
      available: bindingsRaw.available,
      sources: sortByName(array(bindingsRaw.sources)),
      supportedAttributes: sortSupportedAttributes(record(bindingsRaw.supportedAttributes)),
      warnings: warningArray(bindingsRaw.warnings),
    };
  }
  const contentModel = recordWithRecordArray(raw, 'contentModel', 'postTypes');
  const completeContentModel = contentModel && hasCompletePostTypes(contentModel.postTypes) ? contentModel : undefined;
  warnIfMalformed(warnings, raw, 'contentModel', Boolean(completeContentModel));
  if (completeContentModel) {
    collected.contentModel = {
      postTypes: sortPostTypes(array(completeContentModel.postTypes)),
    };
  }
  const patterns = recordWithRecordArray(raw, 'patterns', 'items');
  warnIfMalformed(warnings, raw, 'patterns', Boolean(patterns));
  if (patterns) {
    collected.patterns = {
      items: sortByName(array(patterns.items)),
    };
  }
  const media = recordWithRecordArray(raw, 'media', 'imageSizes');
  warnIfMalformed(warnings, raw, 'media', Boolean(media));
  if (media) {
    collected.media = media;
  }

  // Coverage derives from explicit observed surfaces and evidence-gap warnings,
  // never from severity. In particular, informational REST gaps still make the
  // manifest partial and are considered by strict collection.
  const normalizedEvidence = siteContextSchema.parse(collected);
  (collected.provenance as Record<string, unknown>).partial = coverageFor(normalizedEvidence).some(
    (coverage) => coverage.status !== 'complete',
  );
  const contextWithoutHash = redactSecrets(collected);

  const context = {
    ...contextWithoutHash,
    provenance: {
      ...(contextWithoutHash.provenance as Record<string, unknown>),
      sourceHash: sourceHash(contextWithoutHash),
    },
  };

  return siteContextSchema.parse(context);
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
  return value &&
    typeof value.available === 'boolean' &&
    bindingSourceArray(value.sources) &&
    stringArrayMap(value.supportedAttributes)
    ? value
    : undefined;
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
        hasOwn(record, 'argsSchema') &&
        isJsonValue(record.argsSchema) &&
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

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function array(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? (value.filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>>)
    : [];
}

function sortByName(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...items].sort((left, right) =>
    compareStrings(String(left.name ?? left.key ?? ''), String(right.name ?? right.key ?? '')),
  );
}

function sortPostTypes(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return sortByName(items).map((postType) => ({
    ...postType,
    fields: sortByName(array(postType.fields)),
    taxonomies: Array.isArray(postType.taxonomies) ? postType.taxonomies.map(String).sort(compareStrings) : [],
  }));
}

function sortSupportedAttributes(value: Record<string, unknown>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([blockName, attributes]) => [
        blockName,
        Array.isArray(attributes) ? attributes.map(String).sort(compareStrings) : [],
      ]),
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
