import { createHash } from 'node:crypto';
import { redactSecrets } from './redact.js';

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function sourceHash(value: unknown): string {
  const hash = createHash('sha256');
  hash.update(canonicalize(redactSecrets(withoutVolatileProvenance(value))));
  return `sha256:${hash.digest('hex')}`;
}

export function withoutVolatileProvenance(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const clone = structuredClone(value) as Record<string, unknown>;
  const provenance = clone.provenance;
  if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)) {
    delete (provenance as Record<string, unknown>).collectedAt;
    delete (provenance as Record<string, unknown>).sourceHash;
  }
  return clone;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      // RFC 8785/JCS orders object member names by Unicode code point, not locale collation.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}
