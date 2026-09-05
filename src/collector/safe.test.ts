import { describe, expect, it } from 'vitest';
import { assertNoUrlCredentials, sanitizeErrorMessage } from './safe.js';

describe('collector diagnostic sanitisation', () => {
  it('redacts Authorization headers and credential-bearing command values', () => {
    const authorization = 'Basic c3ludGhldGljLXVzZXI6c3ludGhldGljLXBhc3N3b3Jk';
    const password = 'synthetic-command-password';
    const diagnostic = `request failed; \"Authorization\": \"${authorization}\"; curl -u synthetic-user:${password}`;

    const sanitized = sanitizeErrorMessage(new Error(diagnostic));

    expect(sanitized).toContain('Authorization: [REDACTED]');
    expect(sanitized).not.toContain(authorization);
    expect(sanitized).not.toContain('synthetic-user');
    expect(sanitized).not.toContain(password);
  });

  it('redacts and rejects protocol-relative URLs with userinfo', () => {
    const password = 'synthetic-protocol-relative-password';
    const url = `//synthetic-user:${password}@example.test/wp-json/`;
    const sanitized = sanitizeErrorMessage(`could not open ${url}`);

    expect(sanitized).toContain('[REDACTED_URL]');
    expect(sanitized).not.toContain('synthetic-user');
    expect(sanitized).not.toContain(password);
    expect(() => assertNoUrlCredentials(url, '--wp-url')).toThrow('--wp-url must not contain URL credentials.');
  });

  it('redacts labelled and command-form grouped Application Passwords', () => {
    const camelCasedPassword = 'synthetic-camel-cased-password';
    const groupedPassword = 'abcd efgh ijkl mnop qrst uvwx';
    const sanitized = sanitizeErrorMessage(
      `wpAppPassword=${camelCasedPassword}; WP_API_PASSWORD=${groupedPassword}; --app-password ${groupedPassword}; --application-password=${groupedPassword}`,
    );

    expect(sanitized).toContain('wpAppPassword: [REDACTED]');
    expect(sanitized).toContain('WP_API_PASSWORD: [REDACTED]');
    expect(sanitized).toContain('--app-password=[REDACTED]');
    expect(sanitized).toContain('--application-password=[REDACTED]');
    expect(sanitized).not.toContain(camelCasedPassword);
    for (const group of groupedPassword.split(' ')) {
      expect(sanitized).not.toContain(group);
    }
  });
});
