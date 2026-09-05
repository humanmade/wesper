import { createHash } from 'node:crypto';
import { redactSecrets } from './redact.js';

/**
 * Serialize a JSON value using RFC 8785 (JSON Canonicalization Scheme).
 *
 * JavaScript's JSON.stringify() is deliberately used for primitive strings and
 * numbers: its ECMAScript number rendering is what RFC 8785 specifies. Object
 * members are emitted directly, rather than rebuilding an object and passing it
 * to JSON.stringify(), because JavaScript enumerates integer-like keys in
 * numeric order (for example "2" before "10") rather than JCS order.
 */
export function canonicalize(value: unknown): string {
  return serializeJson(value, new Set<object>());
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

function serializeJson(value: unknown, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'string':
      assertWellFormedUnicode(value);
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('RFC 8785 canonical JSON only supports finite numbers.');
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      if (value === null) {
        return 'null';
      }
      if (ancestors.has(value)) {
        throw new TypeError('Cannot canonicalize a cyclic value.');
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          // Array.from deliberately visits sparse slots, which are not JSON
          // values and therefore fail canonicalization rather than becoming an
          // ambiguous empty element.
          return `[${Array.from(value, (item) => serializeJson(item, ancestors)).join(',')}]`;
        }
        if (!isJsonRecord(value)) {
          throw new TypeError('RFC 8785 canonicalization requires JSON values.');
        }
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
          // JCS sorts names as arrays of UTF-16 code units. String comparison in
          // ECMAScript has precisely those semantics and is locale-independent.
          .sort(compareCodeUnits)
          .map((key) => {
            assertWellFormedUnicode(key);
            return `${JSON.stringify(key)}:${serializeJson(record[key], ancestors)}`;
          })
          .join(',')}}`;
      } finally {
        ancestors.delete(value);
      }
    default:
      throw new TypeError('RFC 8785 canonicalization requires JSON values.');
  }
}

function isJsonRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('RFC 8785 canonical JSON does not permit lone surrogate code points.');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError('RFC 8785 canonical JSON does not permit lone surrogate code points.');
    }
  }
}
