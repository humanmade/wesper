import * as z from 'zod/v4';
import { CONTEXT_VERSION, SCHEMA_URL } from './types.js';

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const warningSeveritySchema = z.enum(['info', 'warning', 'error']);
export const warningCoverageSchema = z.enum(['complete', 'partial', 'unavailable']);

export const contextWarningSchema = z.object({
  code: z.string().min(1),
  severity: warningSeveritySchema,
  message: z.string().min(1),
  surface: z.string().min(1),
  // A collector can make an explicit statement about whether this warning
  // changes the coverage of its surface. Omission is intentionally handled
  // conservatively by coverageFor(), rather than guessed from the code.
  coverage: warningCoverageSchema.optional(),
});

export const validationIssueSchema = z.object({
  code: z.string().min(1),
  path: z.string(),
  message: z.string(),
});

/**
 * V1 registry identifiers are opaque WordPress identifiers. They must be
 * present and whitespace-free, but are not constrained to one vendor's
 * namespace grammar so registered third-party values remain portable.
 */
const identifierSchema = z.string().min(1).regex(/^\S+$/, 'Identifier must not contain whitespace.');
const nonBlankStringSchema = z.string().min(1).regex(/\S/, 'Value must not be blank.');

export const tokenSchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().optional(),
    value: z.string().min(1),
  })
  .passthrough();

export const bindingSourceSchema = z
  .object({
    name: identifierSchema,
    label: z.string().nullable().optional(),
    usesContext: z.array(identifierSchema).default([]),
    argsSchema: jsonValueSchema.nullable().default(null),
  })
  .catchall(jsonValueSchema);

export const bindingFieldSchema = z
  .object({
    name: identifierSchema,
    key: identifierSchema.optional(),
    source: identifierSchema,
    args: z.record(z.string(), jsonValueSchema),
    type: z.string().optional(),
    single: z.boolean().optional(),
    showInRest: z.boolean().optional(),
    // A field is only binding-ready when the collector explicitly says so.
    // Treating omission as true could make consumers write unsupported bindings.
    bindable: z.boolean(),
  })
  .catchall(jsonValueSchema);

export const pluginSchema = z
  .object({
    slug: identifierSchema,
    name: nonBlankStringSchema,
    version: z.string().optional(),
    active: z.boolean(),
    networkActive: z.boolean().optional(),
  })
  .catchall(jsonValueSchema);

export const blockTypeSchema = z
  .object({
    name: identifierSchema,
    apiVersion: z.number().int().positive().nullable().optional(),
    title: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    attributes: z.record(z.string(), jsonValueSchema),
    supports: z.record(z.string(), jsonValueSchema),
    source: z.enum(['core', 'plugin']),
  })
  .catchall(jsonValueSchema);

export const imageSizeSchema = z
  .object({
    name: identifierSchema,
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    crop: z.boolean(),
  })
  .catchall(jsonValueSchema);

export const patternSchema = z
  .object({
    // Pattern names are reusable registry identifiers, not collection offsets.
    name: identifierSchema,
  })
  .catchall(jsonValueSchema);

export const siteContextSchema = z
  .object({
    $schema: z.string().url().default(SCHEMA_URL),
    contextVersion: z.literal(CONTEXT_VERSION),
    site: z
      .object({
        url: z.string().optional(),
        name: z.string().optional(),
        environment: z.enum(['local', 'development', 'staging', 'production', 'unknown']).default('unknown'),
        isMultisite: z.boolean().default(false),
      })
      .passthrough(),
    provenance: z
      .object({
        collectedAt: z.string().datetime(),
        collector: z.enum(['wp-cli', 'rest', 'fixture']),
        collectorVersion: z.string().min(1),
        sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        partial: z.boolean().default(false),
      })
      .passthrough(),
    wordpress: z
      .object({
        version: z.string().optional(),
        locale: z.string().optional(),
        permalinkStructure: z.string().optional(),
        features: z.record(z.string(), z.boolean()).default({}),
      })
      .passthrough()
      .optional(),
    theme: z
      .object({
        stylesheet: z.string().optional(),
        template: z.string().optional(),
        name: z.string().optional(),
        version: z.string().optional(),
        isBlockTheme: z.boolean().optional(),
        themeJsonHash: z.string().optional(),
        settingsOrigin: z.enum(['merged', 'theme', 'custom']).default('merged'),
        tokens: z
          .object({
            colors: z.array(tokenSchema).default([]),
            spacing: z.array(tokenSchema).default([]),
            typography: z.array(tokenSchema).default([]),
          })
          .default({ colors: [], spacing: [], typography: [] }),
        settings: jsonValueSchema.optional(),
      })
      .passthrough()
      .optional(),
    plugins: z.array(pluginSchema).optional(),
    blocks: z
      .object({
        types: z.array(blockTypeSchema).default([]),
      })
      .passthrough()
      .optional(),
    bindings: z
      .object({
        available: z.boolean().default(false),
        sources: z.array(bindingSourceSchema).default([]),
        supportedAttributes: z.record(identifierSchema, z.array(identifierSchema)).default({}),
        warnings: z.array(contextWarningSchema).default([]),
      })
      .passthrough()
      .optional(),
    contentModel: z
      .object({
        postTypes: z
          .array(
            z
              .object({
                name: identifierSchema,
                label: z.string().optional(),
                public: z.boolean().optional(),
                showInRest: z.boolean().optional(),
                taxonomies: z.array(identifierSchema).default([]),
                fields: z.array(bindingFieldSchema).default([]),
              })
              .passthrough(),
          )
          .default([]),
      })
      .passthrough()
      .optional(),
    patterns: z
      .object({
        items: z.array(patternSchema).default([]),
      })
      .passthrough()
      .optional(),
    media: z
      .object({
        imageSizes: z.array(imageSizeSchema).default([]),
        maxUploadSize: z.number().optional(),
      })
      .passthrough()
      .optional(),
    warnings: z.array(contextWarningSchema),
  })
  .passthrough()
  .superRefine(validateManifestRelationships);

type RelationshipManifest = {
  plugins?: Array<{ slug: string }>;
  blocks?: { types: Array<{ name: string }> };
  bindings?: {
    available: boolean;
    sources: Array<{ name: string }>;
    supportedAttributes: Record<string, string[]>;
  };
  contentModel?: {
    postTypes: Array<{
      name: string;
      fields: Array<{ name: string; key?: string; source: string; args: Record<string, unknown>; bindable: boolean }>;
    }>;
  };
  patterns?: { items: Array<{ name: string }> };
  media?: { imageSizes: Array<{ name: string }> };
};

const CORE_POST_DATA_FIELDS = new Set(['date', 'modified', 'link']);

/**
 * JSON Schema cannot express uniqueness across array members or references
 * between fields and registered binding sources. Keep those V1 guarantees in
 * the runtime schema so every parse path receives the same contract.
 */
function validateManifestRelationships(value: RelationshipManifest, ctx: z.RefinementCtx): void {
  uniqueIdentifiers(ctx, value.plugins, 'slug', ['plugins'], 'plugin slug');
  uniqueIdentifiers(ctx, value.blocks?.types, 'name', ['blocks', 'types'], 'block name');
  uniqueIdentifiers(ctx, value.bindings?.sources, 'name', ['bindings', 'sources'], 'binding source name');
  uniqueIdentifiers(ctx, value.patterns?.items, 'name', ['patterns', 'items'], 'pattern name');
  uniqueIdentifiers(ctx, value.media?.imageSizes, 'name', ['media', 'imageSizes'], 'image-size name');
  uniqueIdentifiers(ctx, value.contentModel?.postTypes, 'name', ['contentModel', 'postTypes'], 'post-type name');

  for (const [postTypeIndex, postType] of value.contentModel?.postTypes.entries() ?? []) {
    const fieldPath = ['contentModel', 'postTypes', postTypeIndex, 'fields'] as const;
    uniqueFieldIdentifiers(ctx, postType.fields, 'name', fieldPath, 'field name');
    uniqueFieldIdentifiers(ctx, postType.fields, 'key', fieldPath, 'field key');

    for (const [fieldIndex, field] of postType.fields.entries()) {
      validateCoreSourceArguments(ctx, field, [...fieldPath, fieldIndex]);
    }
  }

  const bindings = value.bindings;
  if (bindings && !bindings.available) {
    if (bindings.sources.length > 0) {
      addRelationshipIssue(
        ctx,
        ['bindings', 'sources'],
        'bindings.unavailable_evidence',
        'bindings.available is false, so bindings.sources must be empty.',
      );
    }
    if (Object.keys(bindings.supportedAttributes).length > 0) {
      addRelationshipIssue(
        ctx,
        ['bindings', 'supportedAttributes'],
        'bindings.unavailable_evidence',
        'bindings.available is false, so bindings.supportedAttributes must be empty.',
      );
    }
  }

  const sourceNames = new Set(bindings?.sources.map((source) => source.name));
  for (const [postTypeIndex, postType] of value.contentModel?.postTypes.entries() ?? []) {
    for (const [fieldIndex, field] of postType.fields.entries()) {
      const fieldPath = ['contentModel', 'postTypes', postTypeIndex, 'fields', fieldIndex] as const;
      if (bindings && !bindings.available && field.bindable) {
        addRelationshipIssue(
          ctx,
          [...fieldPath, 'bindable'],
          'bindings.unavailable_field',
          'Field is bindable even though bindings.available is false.',
        );
      }
      // An omitted bindings section is absent registry evidence, not a registry
      // that implicitly reports every source. Non-bindable fields may still
      // describe custom sources whose argument schemas are not known to V1.
      if (field.bindable && (!bindings || (bindings.available && !sourceNames.has(field.source)))) {
        addRelationshipIssue(
          ctx,
          [...fieldPath, 'source'],
          'bindings.missing_source',
          `Bindable field references unregistered binding source "${field.source}".`,
        );
      }
    }
  }
}

function uniqueFieldIdentifiers(
  ctx: z.RefinementCtx,
  fields: readonly { name: string; key?: string; source: string }[],
  key: 'name' | 'key',
  basePath: readonly (string | number)[],
  label: string,
): void {
  const firstIndex = new Map<string, number>();
  for (const [index, field] of fields.entries()) {
    const value = field[key];
    if (typeof value !== 'string') {
      continue;
    }
    const identifier = `${field.source}\u0000${value}`;
    const first = firstIndex.get(identifier);
    if (first === undefined) {
      firstIndex.set(identifier, index);
      continue;
    }
    addRelationshipIssue(
      ctx,
      [...basePath, index, key],
      'manifest.duplicate_identifier',
      `Duplicate ${label} "${value}" for binding source "${field.source}"; first declared at ${pathText([...basePath, first, key])}.`,
    );
  }
}

function uniqueIdentifiers<T extends Record<string, unknown>>(
  ctx: z.RefinementCtx,
  items: readonly T[] | undefined,
  key: keyof T & string,
  basePath: readonly (string | number)[],
  label: string,
): void {
  const firstIndex = new Map<string, number>();
  for (const [index, item] of items?.entries() ?? []) {
    const value = item[key];
    if (typeof value !== 'string') {
      continue;
    }
    const first = firstIndex.get(value);
    if (first === undefined) {
      firstIndex.set(value, index);
      continue;
    }
    addRelationshipIssue(
      ctx,
      [...basePath, index, key],
      'manifest.duplicate_identifier',
      `Duplicate ${label} "${value}"; first declared at ${pathText([...basePath, first, key])}.`,
    );
  }
}

function validateCoreSourceArguments(
  ctx: z.RefinementCtx,
  field: { name: string; key?: string; source: string; args: Record<string, unknown> },
  fieldPath: readonly (string | number)[],
): void {
  const argumentName = field.source === 'core/post-data'
    ? 'field'
    : field.source === 'core/post-meta'
      ? 'key'
      : undefined;
  if (!argumentName) {
    return;
  }

  const argument = field.args[argumentName];
  const argumentPath = [...fieldPath, 'args', argumentName];
  if (typeof argument !== 'string' || !/^\S+$/.test(argument)) {
    addRelationshipIssue(
      ctx,
      argumentPath,
      'bindings.invalid_core_source_argument',
      `Fields from ${field.source} require a non-blank args.${argumentName} string.`,
    );
    return;
  }

  if (field.source === 'core/post-data' && !CORE_POST_DATA_FIELDS.has(argument)) {
    addRelationshipIssue(
      ctx,
      argumentPath,
      'bindings.invalid_core_source_argument',
      `args.field for core/post-data must be one of ${[...CORE_POST_DATA_FIELDS].join(', ')}.`,
    );
  }

  const expectedArgument = field.key ?? field.name;
  if (argument !== expectedArgument) {
    addRelationshipIssue(
      ctx,
      argumentPath,
      'bindings.invalid_core_source_argument',
      `args.${argumentName} must match the field key or name ("${expectedArgument}").`,
    );
  }
}

function addRelationshipIssue(
  ctx: z.RefinementCtx,
  path: readonly (string | number)[],
  code: string,
  message: string,
): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [...path],
    message,
    params: { code },
  });
}

function pathText(path: readonly (string | number)[]): string {
  return path.join('.');
}

const summaryCountSchema = z.union([z.number(), z.literal('absent')]);

export const summarySchema = z.object({
  site: z.object({
    url: z.string().optional(),
    wordpressVersion: z.string().optional(),
    theme: z.string().optional(),
    collector: z.string(),
    collectedAt: z.string(),
    sourceHash: z.string(),
  }),
  counts: z.object({
    blockTypes: summaryCountSchema,
    bindingSources: summaryCountSchema,
    postTypes: summaryCountSchema,
    bindableFields: summaryCountSchema,
    patterns: summaryCountSchema,
    plugins: summaryCountSchema,
    imageSizes: summaryCountSchema,
    warnings: z.number(),
  }),
  bindingReadiness: z.object({
    supportedAttributes: z.record(z.string(), z.array(z.string())),
    fieldsByPostType: z.record(z.string(), z.number()),
  }),
  coverage: z.record(z.string(), z.enum(['complete', 'partial', 'unavailable'])),
  supportedWork: z.array(z.string()),
  unknownWork: z.array(z.string()),
  warningsBySurface: z.record(z.string(), z.array(contextWarningSchema)),
});

export const siteContextJsonSchema = {
  $id: 'WesperSiteContextV1',
  ...z.toJSONSchema(siteContextSchema, { target: 'draft-7', reused: 'ref', io: 'input' }),
};
