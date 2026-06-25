import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
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

export const contextWarningSchema = z.object({
  code: z.string().min(1),
  severity: warningSeveritySchema,
  message: z.string().min(1),
  surface: z.string().min(1),
});

export const validationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export const tokenSchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().optional(),
    value: z.string().min(1),
  })
  .passthrough();

export const bindingSourceSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().nullable().optional(),
    usesContext: z.array(z.string()).default([]),
    argsSchema: jsonValueSchema.nullable().default(null),
  })
  .passthrough();

export const bindingFieldSchema = z
  .object({
    name: z.string().min(1),
    key: z.string().min(1).optional(),
    source: z.string().min(1),
    args: z.record(z.string(), jsonValueSchema),
    type: z.string().optional(),
    single: z.boolean().optional(),
    showInRest: z.boolean().optional(),
    bindable: z.boolean().default(true),
  })
  .passthrough();

export const siteContextSchema = z
  .object({
    $schema: z.string().url().default(SCHEMA_URL),
    contextVersion: z.literal(CONTEXT_VERSION),
    site: z
      .object({
        url: z.string().optional(),
        name: z.string().optional(),
        environment: z.enum(['local', 'staging', 'production', 'unknown']).default('unknown'),
        isMultisite: z.boolean().default(false),
      })
      .passthrough(),
    provenance: z
      .object({
        collectedAt: z.string().datetime(),
        collector: z.enum(['wp-cli', 'fixture']),
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
      .passthrough(),
    theme: z
      .object({
        stylesheet: z.string().optional(),
        template: z.string().optional(),
        name: z.string().optional(),
        version: z.string().optional(),
        isBlockTheme: z.boolean().optional(),
        themeJsonHash: z.string().optional(),
        settingsOrigin: z.enum(['merged', 'theme']).default('merged'),
        tokens: z
          .object({
            colors: z.array(tokenSchema).default([]),
            spacing: z.array(tokenSchema).default([]),
            typography: z.array(tokenSchema).default([]),
          })
          .default({ colors: [], spacing: [], typography: [] }),
        settings: jsonValueSchema.optional(),
      })
      .passthrough(),
    plugins: z.array(z.record(z.string(), jsonValueSchema)).default([]),
    blocks: z
      .object({
        types: z.array(z.record(z.string(), jsonValueSchema)).default([]),
      })
      .passthrough(),
    bindings: z
      .object({
        available: z.boolean().default(false),
        sources: z.array(bindingSourceSchema).default([]),
        supportedAttributes: z.record(z.string(), z.array(z.string())).default({}),
        warnings: z.array(contextWarningSchema).default([]),
      })
      .passthrough(),
    contentModel: z
      .object({
        postTypes: z
          .array(
            z
              .object({
                name: z.string().min(1),
                label: z.string().optional(),
                public: z.boolean().optional(),
                showInRest: z.boolean().optional(),
                taxonomies: z.array(z.string()).default([]),
                fields: z.array(bindingFieldSchema).default([]),
              })
              .passthrough(),
          )
          .default([]),
      })
      .passthrough(),
    patterns: z
      .object({
        items: z.array(z.record(z.string(), jsonValueSchema)).default([]),
      })
      .passthrough(),
    media: z
      .object({
        imageSizes: z.array(z.record(z.string(), jsonValueSchema)).default([]),
        maxUploadSize: z.number().optional(),
      })
      .passthrough(),
    warnings: z.array(contextWarningSchema).default([]),
  })
  .passthrough();

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
    blockTypes: z.number(),
    bindingSources: z.number(),
    postTypes: z.number(),
    bindableFields: z.number(),
    patterns: z.number(),
    plugins: z.number(),
    imageSizes: z.number(),
    warnings: z.number(),
  }),
  bindingReadiness: z.object({
    supportedAttributes: z.record(z.string(), z.array(z.string())),
    fieldsByPostType: z.record(z.string(), z.number()),
  }),
  warningsBySurface: z.record(z.string(), z.array(contextWarningSchema)),
});

export const siteContextJsonSchema = zodToJsonSchema(siteContextSchema, {
  name: 'WesperSiteContextV1',
  $refStrategy: 'root',
  target: 'jsonSchema7',
});
