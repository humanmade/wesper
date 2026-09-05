import { sanitizeErrorMessage } from './collector/safe.js';

// Whole-word credential tokens. A key is redacted if any of its tokens matches —
// where tokens are split on camelCase boundaries and on _/-/ separators, so
// `clientSecret`, `authorization_header`, and `app-password` all tokenize correctly.
const SECRET_WORDS = new Set([
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'token',
  'credential',
  'credentials',
  'authorization',
  'cookie',
  'nonce',
  'bearer',
]);

// `key` alone is too common to redact (slugs, map keys). It is a credential only
// when qualified — apiKey, privateKey, clientKey, signingKey, accessKey, …
const KEY_QUALIFIERS = new Set([
  'api',
  'private',
  'secret',
  'access',
  'signing',
  'encryption',
  'client',
  'consumer',
  'license',
  'refresh',
  'auth',
]);

export const REDACTED = '[REDACTED]';

const ENCODED_REDACTED = encodeURIComponent(REDACTED);
// URLs can be standalone values or occur in an otherwise innocuous command
// string such as `wp --url=https://user:password@example.test`. Redact every
// userinfo segment, not just a string that begins with one.
const URL_USERINFO = /((?:\b[a-z][a-z0-9+.-]*:)?\/\/)[^/?#\s]*@/gi;

/** Maximum container nesting accepted at the package boundary. */
export const MAX_REDACTION_DEPTH = 64;

/** Maximum object members and array slots inspected in one redaction pass. */
export const MAX_REDACTION_NODES = 100_000;

export type RedactionErrorCode = 'cycle' | 'depth' | 'nodes' | 'unsafe_input';

/**
 * A bounded, value-free error for inputs which cannot safely be traversed.
 *
 * `redactSecrets` accepts JSON-like values, but intentionally refuses circular,
 * excessively nested or excessively wide structures. Package boundaries should
 * catch this error and return their usual invalid-input result rather than
 * logging the original value.
 */
export class RedactionError extends Error {
  readonly code: RedactionErrorCode;

  constructor(code: RedactionErrorCode) {
    super(redactionErrorMessage(code));
    this.name = 'RedactionError';
    this.code = code;
  }
}

/**
 * Return a copy with credential-like keys and URL userinfo redacted.
 *
 * The traversal is deliberately bounded (see `RedactionError`) so malformed
 * untrusted input has a deterministic failure path instead of exhausting the
 * JavaScript call stack. Only the returned copy is safe to hash, serialize or
 * include in diagnostics.
 *
 * @throws {RedactionError} when the input is cyclic, too deeply/widely nested,
 * or cannot be read as plain data without invoking an accessor.
 */
export function redactSecrets<T>(value: T): T {
  return redact(value, { active: new WeakSet<object>(), nodes: 0 }, 0) as T;
}

interface RedactionState {
  active: WeakSet<object>;
  nodes: number;
}

function isSecretKey(key: string): boolean {
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
  if (tokens.some((token) => SECRET_WORDS.has(token))) {
    return true;
  }
  return tokens.includes('key') && tokens.some((token) => KEY_QUALIFIERS.has(token));
}

function redact(value: unknown, state: RedactionState, depth: number): unknown {
  if (typeof value === 'string') {
    return redactUrlUserinfo(value);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (depth >= MAX_REDACTION_DEPTH) {
    throw new RedactionError('depth');
  }
  if (state.active.has(value)) {
    throw new RedactionError('cycle');
  }

  state.active.add(value);
  try {
    if (isArray(value)) {
      return redactArray(value, state, depth);
    }
    return redactObject(value, state, depth);
  } finally {
    state.active.delete(value);
  }
}

function redactArray(value: unknown[], state: RedactionState, depth: number): unknown[] {
  const length = arrayLength(value);
  consumeNodes(state, length);
  const result = new Array<unknown>(length);

  for (let index = 0; index < length; index += 1) {
    const descriptor = ownDataDescriptor(value, String(index));
    if (!descriptor) {
      continue;
    }
    result[index] = redact(descriptor.value, state, depth + 1);
  }

  return result;
}

function isArray(value: object): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    throw new RedactionError('unsafe_input');
  }
}

function arrayLength(value: unknown[]): number {
  try {
    return value.length;
  } catch {
    throw new RedactionError('unsafe_input');
  }
}

function redactObject(value: object, state: RedactionState, depth: number): Record<string, unknown> {
  const keys = ownEnumerableKeys(value);
  consumeNodes(state, keys.length);

  // `defineProperty` is intentional: assignment to a normal `{}` invokes the
  // legacy __proto__ setter, so a hostile dictionary key could otherwise mutate
  // the result's prototype while it is being redacted.
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const redactedValue = isSecretKey(key)
      ? REDACTED
      : redactObjectValue(key, value, state, depth);
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: redactedValue,
      writable: true,
    });
  }
  return result;
}

function redactObjectValue(key: string, value: object, state: RedactionState, depth: number): unknown {
  const redactedValue = redactDataProperty(value, key, state, depth);
  // Collector warnings use the non-secret `message` key. Treat that text as a
  // diagnostic so credentials embedded in it cannot cross a package boundary.
  return key === 'message' && typeof redactedValue === 'string' ? sanitizeErrorMessage(redactedValue) : redactedValue;
}

function redactDataProperty(value: object, key: string, state: RedactionState, depth: number): unknown {
  const descriptor = ownDataDescriptor(value, key);
  if (!descriptor) {
    throw new RedactionError('unsafe_input');
  }

  // JSON.stringify would call an own toJSON method on the copied result. Never
  // retain executable input at that serialization boundary.
  if (key === 'toJSON' && typeof descriptor.value === 'function') {
    throw new RedactionError('unsafe_input');
  }
  return redact(descriptor.value, state, depth + 1);
}

function ownEnumerableKeys(value: object): string[] {
  try {
    return Object.keys(value);
  } catch {
    throw new RedactionError('unsafe_input');
  }
}

function ownDataDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new RedactionError('unsafe_input');
  }
  if (!descriptor) {
    return undefined;
  }
  if (!('value' in descriptor)) {
    throw new RedactionError('unsafe_input');
  }
  return descriptor;
}

function consumeNodes(state: RedactionState, count: number): void {
  if (count > MAX_REDACTION_NODES - state.nodes) {
    throw new RedactionError('nodes');
  }
  state.nodes += count;
}

function redactUrlUserinfo(value: string): string {
  // Deliberately identify userinfo without requiring the rest of the URL to be
  // valid. A malformed URL can still contain an application password, and must
  // not survive into a manifest or diagnostic unchanged.
  return value.replace(URL_USERINFO, `$1${ENCODED_REDACTED}@`);
}

function redactionErrorMessage(code: RedactionErrorCode): string {
  switch (code) {
    case 'cycle':
      return 'Redaction refused a cyclic input value.';
    case 'depth':
      return `Redaction refused input nested beyond ${MAX_REDACTION_DEPTH} levels.`;
    case 'nodes':
      return `Redaction refused input with more than ${MAX_REDACTION_NODES} members or array slots.`;
    case 'unsafe_input':
      return 'Redaction refused input that cannot be read safely as data.';
  }
}
