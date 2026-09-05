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

export const patternSchema = z
  .object({
    // Pattern names are reusable registry identifiers, not collection offsets.
    name: z.string().min(1).regex(/\S/, 'Pattern name must not be blank.'),
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
    plugins: z.array(z.record(z.string(), jsonValueSchema)).optional(),
    blocks: z
      .object({
        types: z.array(z.record(z.string(), jsonValueSchema)).default([]),
      })
      .passthrough()
      .optional(),
    bindings: z
      .object({
        available: z.boolean().default(false),
        sources: z.array(bindingSourceSchema).default([]),
        supportedAttributes: z.record(z.string(), z.array(z.string())).default({}),
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
        imageSizes: z.array(z.record(z.string(), jsonValueSchema)).default([]),
        maxUploadSize: z.number().optional(),
      })
      .passthrough()
      .optional(),
    warnings: z.array(contextWarningSchema),
  })
  .passthrough();

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
