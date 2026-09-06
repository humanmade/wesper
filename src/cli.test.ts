import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SCHEMA_URL } from './types.js';

describe('CLI', () => {
  it('lists current commands, rejects diff, and reports the package version', async () => {
    const help = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--help'], { cwd: process.cwd(), encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('collect');
    expect(help.stdout).toContain('validate');
    expect(help.stdout).toContain('summarize');
    expect(help.stdout).not.toContain('diff');

    const diff = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'diff'], { cwd: process.cwd(), encoding: 'utf8' });
    expect(diff.status).toBe(2);
    expect(diff.stderr).toContain('unknown command');

    const packageVersion = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    const version = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--version'], { cwd: process.cwd(), encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(packageVersion);
  });

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

  it('returns the usage status for incompatible collection options', async () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'collect', '--rest', '--wp-path', '/tmp/wp'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--rest cannot be combined with --wp-path or --ssh.');
  });

  it('returns the usage status for Commander option errors', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'collect', '--not-an-option'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown option');
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

  it('allows partial evidence normally but rejects it under strict policy', async () => {
    const wpDir = await mkdtemp(path.join(tmpdir(), 'wesper-cli-wp-'));
    const wp = path.join(wpDir, 'wp');
    await writeFile(
      wp,
      `#!/bin/sh
printf '%s\\n' '${JSON.stringify(partialCollectorOutput())}'
`,
      { mode: 0o755 },
    );
    await chmod(wp, 0o755);
    const partialOutput = path.join(wpDir, 'partial.context.json');
    const partialResult = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'collect', '--wp-path', '/tmp/wp', '--out', partialOutput],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PATH: wpDir } },
    );

    expect(partialResult.status).toBe(0);
    expect(JSON.parse(await readFile(partialOutput, 'utf8'))).toMatchObject({ provenance: { partial: true } });

    const strictOutput = path.join(wpDir, 'strict.context.json');
    const strictResult = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'collect', '--wp-path', '/tmp/wp', '--strict', '--out', strictOutput],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PATH: wpDir } },
    );

    expect(strictResult.status).toBe(1);
    expect(strictResult.stderr).toContain('Strict collection failed');
    await expect(access(strictOutput)).rejects.toThrow();
  });

  it('returns the transport status when WP-CLI cannot be executed', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'collect', '--wp-path', '/tmp/wp'],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PATH: '/definitely-not-a-path' } },
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('wesper collect:');
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

function partialCollectorOutput(): Record<string, unknown> {
  return {
    site: { environment: 'local', isMultisite: false },
    wordpress: { features: {} },
    theme: { settings: {} },
    plugins: [],
    blocks: { types: [] },
    bindings: { available: false, sources: [], supportedAttributes: {}, warnings: [] },
    contentModel: { postTypes: [] },
    patterns: { items: [] },
    media: { imageSizes: [] },
    warnings: [
      {
        code: 'bindings.unavailable',
        severity: 'info',
        surface: 'bindings',
        message: 'Block bindings could not be read.',
      },
    ],
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
