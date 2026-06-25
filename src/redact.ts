const SECRET_KEY_PATTERN = /(^|[_-])(password|passwd|pwd|secret|authorization|cookie|nonce|credential)($|[_-])|app[_-]?password|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer/i;

export const REDACTED = '[REDACTED]';

export function redactSecrets<T>(value: T): T {
  return redact(value) as T;
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
    result[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(nested);
  }
  return result;
}
