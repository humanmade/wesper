import { canonicalize, sourceHash } from '../canonical.js';
import { redactSecrets } from '../redact.js';
import { siteContextSchema } from '../schema.js';
import { parseThemeJsonSettings, themeWarnings } from '../theme.js';
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
  if (hasOwn(redactedRaw, 'theme')) {
    const settings = record(redactedRaw.theme).settings;
    warnings.push(...themeWarnings(settings));
  }
  const sortedWarnings = sortWarnings(warnings);

  const collected: Record<string, unknown> = {
    $schema: SCHEMA_URL,
    contextVersion: CONTEXT_VERSION,
    site: record(redactedRaw.site),
    provenance: {
      collectedAt: new Date().toISOString(),
      collector: opts.collector,
      collectorVersion: opts.collectorVersion,
      sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      partial: sortedWarnings.some((warning) => warning.severity !== 'info'),
    },
    warnings: sortedWarnings,
  };
  if (hasOwn(redactedRaw, 'wordpress')) {
    collected.wordpress = record(redactedRaw.wordpress);
  }
  if (hasOwn(redactedRaw, 'theme')) {
    const themeRaw = record(redactedRaw.theme);
    const settings = themeRaw.settings;
    collected.theme = {
      ...themeRaw,
      // REST global-styles exposes the user-customization layer, not the fully merged
      // theme.json settings WP-CLI reads via wp_get_global_settings(); stamp the origin honestly.
      settingsOrigin: opts.collector === 'rest' ? 'custom' : 'merged',
      ...(settings === undefined ? {} : { themeJsonHash: sourceHash({ settings }) }),
      tokens: parseThemeJsonSettings(settings),
      ...(settings === undefined ? {} : { settings }),
    };
  }
  if (hasOwn(redactedRaw, 'plugins')) {
    collected.plugins = sortPlugins(array(redactedRaw.plugins));
  }
  if (hasOwn(redactedRaw, 'blocks')) {
    collected.blocks = {
      types: sortByName(array(record(redactedRaw.blocks).types)),
    };
  }
  if (hasOwn(redactedRaw, 'bindings')) {
    const bindingsRaw = record(redactedRaw.bindings);
    collected.bindings = {
      available: Boolean(bindingsRaw.available),
      sources: sortBindingSources(array(bindingsRaw.sources)),
      supportedAttributes: sortSupportedAttributes(record(bindingsRaw.supportedAttributes)),
      warnings: sortWarnings(warningArray(bindingsRaw.warnings)),
    };
  }
  if (hasOwn(redactedRaw, 'contentModel')) {
    collected.contentModel = {
      postTypes: sortPostTypes(array(record(redactedRaw.contentModel).postTypes)),
    };
  }
  if (hasOwn(redactedRaw, 'patterns')) {
    collected.patterns = {
      items: sortPatterns(array(record(redactedRaw.patterns).items)),
    };
  }
  if (hasOwn(redactedRaw, 'media')) {
    const mediaRaw = record(redactedRaw.media);
    collected.media = {
      ...mediaRaw,
      ...(hasOwn(mediaRaw, 'imageSizes') ? { imageSizes: sortByName(array(mediaRaw.imageSizes)) } : {}),
    };
  }

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
