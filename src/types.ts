import type * as z from 'zod/v4';
import type {
  bindingFieldSchema,
  bindingSourceSchema,
  contextWarningSchema,
  siteContextSchema,
  summarySchema,
  validationIssueSchema,
} from './schema.js';

export const CONTEXT_VERSION = 1 as const;
export const SCHEMA_URL = 'https://humanmade.github.io/wesper/schemas/site-context-v1.schema.json' as const;

export type CollectorKind = 'wp-cli' | 'fixture';
export type Environment = 'local' | 'development' | 'staging' | 'production' | 'unknown';
export type WarningSeverity = 'info' | 'warning' | 'error';

export type ContextWarning = z.infer<typeof contextWarningSchema>;
export type BindingSource = z.infer<typeof bindingSourceSchema>;
export type BindingField = z.infer<typeof bindingFieldSchema>;
export type SiteContext = z.infer<typeof siteContextSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

export interface ValidationResult {
  ok: boolean;
  context?: SiteContext;
  errors: ValidationIssue[];
  warnings: ContextWarning[];
}

export interface CollectOptions {
  collector?: CollectorKind;
  wpPath?: string;
  wpUrl?: string;
  ssh?: string;
  strict?: boolean;
  wpBinary?: string;
}

export interface WpCliExecOptions extends CollectOptions {
  collector: 'wp-cli';
}
