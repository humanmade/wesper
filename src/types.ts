import type * as z from 'zod/v4';
import type {
  blockTypeSchema,
  bindingFieldSchema,
  bindingSourceSchema,
  contextWarningSchema,
  imageSizeSchema,
  pluginSchema,
  siteContextSchema,
  summarySchema,
  validationIssueSchema,
} from './schema.js';

export const CONTEXT_VERSION = 1 as const;
export const SCHEMA_URL = 'https://humanmade.github.io/wesper/schemas/site-context-v1.schema.json' as const;

/**
 * V1 accepts additive JSON extension properties, while its documented records
 * and relationships are validated. Consumers must ignore extensions they do
 * not understand so future V1-compatible manifests remain readable.
 */
export const V1_COMPATIBILITY = {
  extensionProperties: 'preserve-and-ignore',
  knownRecords: 'validate',
} as const;

export type CollectorKind = 'wp-cli' | 'rest' | 'fixture';
export type Environment = 'local' | 'development' | 'staging' | 'production' | 'unknown';
export type WarningSeverity = 'info' | 'warning' | 'error';
export type CollectionErrorCode = 'WESPER_USAGE' | 'WESPER_STRICT_POLICY' | 'WESPER_TRANSPORT';

/** Base class for collection errors with a stable, machine-readable meaning. */
export class CollectionError extends Error {
  constructor(
    message: string,
    readonly code: CollectionErrorCode,
  ) {
    super(message);
    this.name = 'CollectionError';
  }
}

/** The caller supplied unsupported, incomplete, or unsafe collection options. */
export class UsageError extends CollectionError {
  constructor(message: string) {
    super(message, 'WESPER_USAGE');
    this.name = 'UsageError';
  }
}

/** A strict collection policy was not satisfied by the collected evidence. */
export class StrictCollectionError extends CollectionError {
  constructor(message: string) {
    super(message, 'WESPER_STRICT_POLICY');
    this.name = 'StrictCollectionError';
  }
}

/** A collector could not execute or return a valid manifest. */
export class CollectionTransportError extends CollectionError {
  constructor(message: string, readonly reason?: CollectionFailureReason) {
    super(message, 'WESPER_TRANSPORT');
    this.name = 'CollectionTransportError';
  }
}

/** A safe operational reason suitable for callers and CLI diagnostics. */
export type CollectionFailureReason =
  | 'cancelled'
  | 'deadline_exceeded'
  | 'timeout'
  | 'route_unavailable'
  | 'authentication_failed'
  | 'permission_denied'
  | 'response_too_large'
  | 'malformed_response'
  | 'transport_failed'
  | 'process_failed';

export type ContextWarning = z.infer<typeof contextWarningSchema>;
export type Plugin = z.infer<typeof pluginSchema>;
export type BlockType = z.infer<typeof blockTypeSchema>;
export type ImageSize = z.infer<typeof imageSizeSchema>;
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
  wpUser?: string;
  wpAppPassword?: string;
  ssh?: string;
  strict?: boolean;
  wpBinary?: string;
  /** Cancel an in-flight collection. */
  signal?: AbortSignal;
  /** Maximum wall-clock time for the entire collection, in milliseconds. */
  timeoutMs?: number;
  /** Maximum simultaneous independent REST requests. */
  restConcurrency?: number;
  /** Maximum bytes accepted from one REST response. */
  maxResponseBytes?: number;
}

export interface WpCliExecOptions extends CollectOptions {
  collector: 'wp-cli';
}
