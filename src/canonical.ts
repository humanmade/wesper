import { createHash } from 'node:crypto';
import { redactSecrets } from './redact.js';

export function canonicalize(value: unknown): string {
  // Canonicalization is a public package boundary too. Work only from the
  // bounded, data-only copy so it cannot recurse indefinitely or turn a
  // credential-bearing URL into a stable leaked representation.
  return canonicalizeRedacted(redactSecrets(value));
}

export function sourceHash(value: unknown): string {
  const hash = createHash('sha256');
  // Redact before cloning or recursively sorting: callers can pass arbitrary
  // manifest-shaped input and no raw credential should reach the hash input.
  const redacted = redactSecrets(value);
  hash.update(canonicalizeRedacted(withoutVolatileProvenance(redacted)));
  return `sha256:${hash.digest('hex')}`;
}

function canonicalizeRedacted(value: unknown): string {
  return JSON.stringify(sortJson(value));
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
