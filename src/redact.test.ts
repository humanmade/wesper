import { describe, expect, it } from 'vitest';
import { sourceHash } from './canonical.js';
import {
  MAX_REDACTION_DEPTH,
  MAX_REDACTION_NODES,
  REDACTED,
  RedactionError,
  redactSecrets,
} from './redact.js';

describe('redactSecrets', () => {
  it('sanitises URL userinfo without changing ordinary schema and design-token metadata', () => {
    const applicationPassword = 'synthetic-app-password-123';
    const authorizationValue = 'SyntheticAuthorizationValue';
    const result = redactSecrets({
      $schema: 'https://schemas.example.test/site-context-v1.json',
      theme: {
        tokens: {
          colors: [{ slug: 'brand', name: 'Brand', value: '#1357ff' }],
        },
      },
      url: `https://site-user:${applicationPassword}@example.test/wp-json/?authorization=${authorizationValue}`,
    });

    expect(result.$schema).toBe('https://schemas.example.test/site-context-v1.json');
    expect(result.theme).toEqual({
      tokens: { colors: [{ slug: 'brand', name: 'Brand', value: '#1357ff' }] },
    });
    expect(result.url).toBe('https://%5BREDACTED%5D@example.test/wp-json/?authorization=SyntheticAuthorizationValue');
    expect(JSON.stringify(result)).not.toContain(applicationPassword);
    expect(JSON.stringify(result)).not.toContain('site-user');
  });

  it('sanitises malformed and protocol-relative URLs with userinfo too', () => {
    const malformed = 'https://synthetic-user:synthetic-app-password@';
    const protocolRelative = '//synthetic-user:synthetic-app-password@example.test/path';
    const command = 'wp --url=https://synthetic-user:synthetic-app-password@example.test/wp-json/';
    const result = redactSecrets({ malformed, protocolRelative, command });

    expect(result).toEqual({
      malformed: 'https://%5BREDACTED%5D@',
      protocolRelative: '//%5BREDACTED%5D@example.test/path',
      command: 'wp --url=https://%5BREDACTED%5D@example.test/wp-json/',
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-app-password');
  });

  it('uses the sanitised URL value when deriving source hashes', () => {
    const credentialBearing = { url: 'https://synthetic-user:synthetic-app-password@example.test/wp-json/' };
    const sanitised = { url: 'https://%5BREDACTED%5D@example.test/wp-json/' };

    expect(sourceHash(credentialBearing)).toBe(sourceHash(sanitised));
  });

  it('keeps hostile dictionary keys as data without changing the output prototype', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"safe":true}}') as Record<string, unknown>;
    const result = redactSecrets(input) as Record<string, unknown>;

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
    expect(result.__proto__).toEqual({ polluted: true });
    expect(result.constructor).toEqual({ safe: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('has a bounded, value-free failure for cycles and excessive nesting', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    let nested: unknown = { value: 'safe' };
    for (let depth = 0; depth <= MAX_REDACTION_DEPTH; depth += 1) {
      nested = { nested };
    }

    for (const value of [cyclic, nested, new Array(MAX_REDACTION_NODES + 1)]) {
      try {
        redactSecrets(value);
        throw new Error('Expected redaction to reject unbounded input.');
      } catch (error) {
        expect(error).toBeInstanceOf(RedactionError);
        expect(error).not.toHaveProperty('message', expect.stringContaining('synthetic-app-password'));
      }
    }
  });

  it('does not invoke accessors while traversing untrusted values', () => {
    const input = {};
    Object.defineProperty(input, 'value', {
      enumerable: true,
      get: () => {
        throw new Error('synthetic-app-password');
      },
    });

    expect(() => redactSecrets(input)).toThrow(RedactionError);
    expect(() => redactSecrets({ appPassword: 'synthetic-app-password' })).not.toThrow();
    expect(redactSecrets({ appPassword: 'synthetic-app-password' })).toEqual({ appPassword: REDACTED });
  });
});
