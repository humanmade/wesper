import { sourceHash } from '../canonical.js';
import { redactSecrets } from '../redact.js';
import { siteContextSchema } from '../schema.js';
import { parseThemeJsonSettings, themeWarnings } from '../theme.js';
import { CONTEXT_VERSION, SCHEMA_URL, type ContextWarning, type SiteContext } from '../types.js';

export const COLLECTOR_VERSION = '0.1.0';

export function normalizeCollectorOutput(
  raw: Record<string, unknown>,
  opts: { collector: 'wp-cli' | 'rest'; collectorVersion: string },
): SiteContext {
  const warnings = warningArray(raw.warnings);
  if (hasOwn(raw, 'theme')) {
    const settings = record(raw.theme).settings;
    warnings.push(...themeWarnings(settings));
  }

  const collected: Record<string, unknown> = {
    $schema: SCHEMA_URL,
    contextVersion: CONTEXT_VERSION,
    site: record(raw.site),
    provenance: {
      collectedAt: new Date().toISOString(),
      collector: opts.collector,
      collectorVersion: opts.collectorVersion,
      sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      partial: warnings.some((warning) => warning.severity !== 'info'),
    },
    warnings,
  };
  if (hasOwn(raw, 'wordpress')) {
    collected.wordpress = record(raw.wordpress);
  }
  if (hasOwn(raw, 'theme')) {
    const themeRaw = record(raw.theme);
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
  if (hasOwn(raw, 'plugins')) {
    collected.plugins = array(raw.plugins);
  }
  if (hasOwn(raw, 'blocks')) {
    collected.blocks = {
      types: sortByName(array(record(raw.blocks).types)),
    };
  }
  if (hasOwn(raw, 'bindings')) {
    const bindingsRaw = record(raw.bindings);
    collected.bindings = {
      available: Boolean(bindingsRaw.available),
      sources: sortByName(array(bindingsRaw.sources)),
      supportedAttributes: sortSupportedAttributes(record(bindingsRaw.supportedAttributes)),
      warnings: warningArray(bindingsRaw.warnings),
    };
  }
  if (hasOwn(raw, 'contentModel')) {
    collected.contentModel = {
      postTypes: sortPostTypes(array(record(raw.contentModel).postTypes)),
    };
  }
  if (hasOwn(raw, 'patterns')) {
    collected.patterns = {
      items: sortByName(array(record(raw.patterns).items)),
    };
  }
  if (hasOwn(raw, 'media')) {
    collected.media = record(raw.media);
  }
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
