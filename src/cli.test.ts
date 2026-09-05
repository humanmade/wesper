import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SCHEMA_URL } from './types.js';

describe('CLI summarize', () => {
  it('rejects unsupported formats', async () => {
    const manifestPath = await writeFixture();
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'summarize', manifestPath, '--format', 'jsn'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unsupported format "jsn"');
  });

  it('accepts json format', async () => {
    const manifestPath = await writeFixture();
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'summarize', manifestPath, '--format', 'json'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      counts: { blockTypes: 0, warnings: 0 },
    });
  });

  it('rejects combining --rest with WP-CLI transport options', async () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'collect', '--rest', '--wp-path', '/tmp/wp'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('--rest cannot be combined with --wp-path or --ssh.');
  });

  it('redacts credentials from CLI error diagnostics', () => {
    const password = 'synthetic-cli-app-password';
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'validate', `https://synthetic-user:${password}@example.test/manifest.json`],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('[REDACTED_URL]');
    expect(result.stderr).not.toContain('synthetic-user');
    expect(result.stderr).not.toContain(password);
  });

  it('redacts camel-cased and space-separated Application Passwords from CLI diagnostics', () => {
    const camelCasedPassword = 'synthetic-camel-cased-password';
    const groupedPassword = 'abcd efgh ijkl mnop qrst uvwx';
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'validate',
        `wpAppPassword=${camelCasedPassword}; WP_API_PASSWORD=${groupedPassword}`,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('wpAppPassword: [REDACTED]');
    expect(result.stderr).toContain('WP_API_PASSWORD: [REDACTED]');
    expect(result.stderr).not.toContain(camelCasedPassword);
    for (const group of groupedPassword.split(' ')) {
      expect(result.stderr).not.toContain(group);
    }
  });

  it('prints nested binding warnings during validate and exits nonzero', async () => {
    const manifestPath = await writeFixture({
      bindings: {
        warnings: [
          {
            code: 'bindings.partial',
            severity: 'warning',
            surface: 'bindings',
            message: 'Binding support is partial.',
          },
        ],
      },
    });
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'validate', manifestPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[bindings.partial] Binding support is partial.');
  });
});

async function writeFixture(overrides: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wesper-cli-'));
  const manifestPath = path.join(dir, 'site.context.json');
  await writeFile(manifestPath, JSON.stringify(deepMerge(fixture(), overrides)));
  return manifestPath;
}

function fixture(): Record<string, unknown> {
  return {
    $schema: SCHEMA_URL,
    contextVersion: 1,
    site: { environment: 'local', isMultisite: false },
    provenance: {
      collectedAt: '2026-06-25T00:00:00.000Z',
      collector: 'fixture',
      collectorVersion: '0.1.0',
      sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      partial: false,
    },
    wordpress: { features: {} },
    theme: { settingsOrigin: 'merged', tokens: { colors: [], spacing: [], typography: [] } },
    plugins: [],
    blocks: { types: [] },
    bindings: { available: true, sources: [], supportedAttributes: {}, warnings: [] },
    contentModel: { postTypes: [] },
    patterns: { items: [] },
    media: { imageSizes: [] },
    warnings: [],
  };
}

function deepMerge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const output = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      output[key] &&
      typeof output[key] === 'object' &&
      !Array.isArray(output[key])
    ) {
      output[key] = deepMerge(output[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      output[key] = value;
    }
  }
  return output;
}
