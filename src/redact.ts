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

export function redactSecrets<T>(value: T): T {
  return redact(value) as T;
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

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = isSecretKey(key) ? REDACTED : redact(nested);
  }
  return result;
}
