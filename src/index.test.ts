import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalize, sourceHash } from './canonical.js';
import { redactSecrets } from './redact.js';
import { siteContextJsonSchema } from './schema.js';
import { parseThemeJsonSettings } from './theme.js';
import { SCHEMA_URL, type SiteContext } from './types.js';
import { formatSummaryMarkdown, stringifyManifest, summarize, validate } from './index.js';

describe('validation', () => {
  it('accepts the canonical V1 shape and preserves unknown top-level keys', () => {
    const manifest = fixture({ abilities: { future: true } });
    const result = validate(manifest);

    expect(result.ok).toBe(true);
    expect(result.context?.contextVersion).toBe(1);
    expect((result.context as SiteContext & { abilities?: unknown }).abilities).toEqual({ future: true });
  });

  it('rejects malformed manifests with useful paths', () => {
    const result = validate({ contextVersion: 2 });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === 'contextVersion')).toBe(true);
  });

  it('rejects patterns without usable string identifiers', () => {
    const result = validate(
      fixture({
        patterns: { items: [{ name: 0 }, { name: '   ' }] },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining(['patterns.items.0.name', 'patterns.items.1.name']),
    );
  });

  it('includes nested binding warnings in validation results', () => {
    const result = validate(
      fixture({
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
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      {
        code: 'bindings.partial',
        severity: 'warning',
        surface: 'bindings',
        message: 'Binding support is partial.',
      },
    ]);
  });

  it('accepts a minimal manifest with only required contract surfaces', () => {
    const result = validate({
      contextVersion: 1,
      site: {},
      provenance: {
        collectedAt: '2026-06-25T00:00:00.000Z',
        collector: 'fixture',
        collectorVersion: '0.1.0',
        sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
      warnings: [],
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.context?.$schema).toBe(SCHEMA_URL);
  });

  it('exports an input JSON Schema with only raw input requirements', () => {
    expect((siteContextJsonSchema as { required?: string[] }).required).toEqual([
      'contextVersion',
      'site',
      'provenance',
      'warnings',
    ]);
  });

  it('accepts WordPress development environment manifests', () => {
    const result = validate(fixture({ site: { environment: 'development' } }));

    expect(result.ok).toBe(true);
    expect(result.context?.site.environment).toBe('development');
  });

  it('treats an omitted section with a matching warning as absent, not empty', () => {
    const manifest = fixture({
      warnings: [
        {
          code: 'patterns.unavailable',
          severity: 'warning',
          surface: 'patterns',
          message: 'Patterns could not be collected.',
        },
      ],
    });
    delete manifest.patterns;

    const result = validate(manifest);

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      {
        code: 'patterns.unavailable',
        severity: 'warning',
        surface: 'patterns',
        message: 'Patterns could not be collected.',
      },
    ]);
    expect(result.context?.patterns).toBeUndefined();
  });

  it('warns when a content section is omitted without a matching warning', () => {
    const manifest = fixture();
    delete manifest.patterns;

    const result = validate(manifest);

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual({
      code: 'absent_without_warning',
      severity: 'warning',
      surface: 'patterns',
      message: 'Manifest section "patterns" is absent without a matching warning.',
    });
  });
});

describe('sourceHash and redaction', () => {
  it('canonicalizes object keys by RFC 8785 code-unit order regardless of process locale', () => {
    const originalLang = process.env.LANG;
    const value = { Z: true, a: true, _internal: true, '40': true };

    try {
      const expected = '{"40":true,"Z":true,"_internal":true,"a":true}';
      process.env.LANG = 'sv_SE.UTF-8';
      expect(canonicalize(value)).toBe(expected);

      const firstHash = sourceHash(value);
      process.env.LANG = 'tr_TR.UTF-8';
      expect(canonicalize(value)).toBe(expected);
      expect(sourceHash(value)).toBe(firstHash);
    } finally {
      process.env.LANG = originalLang;
    }
  });

  it('excludes collectedAt and sourceHash from the hash', () => {
    const first = fixture({
      provenance: {
        collectedAt: '2026-06-25T00:00:00.000Z',
        sourceHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      },
    });
    const second = fixture({
      provenance: {
        collectedAt: '2026-06-26T00:00:00.000Z',
        sourceHash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      },
    });

    expect(sourceHash(first)).toBe(sourceHash(second));
  });

  it('redacts nested secret-like keys before returning validation data', () => {
    const redacted = redactSecrets({ nested: { appPassword: 'secret', safe: 'ok' } });

    expect(redacted).toEqual({ nested: { appPassword: '[REDACTED]', safe: 'ok' } });
  });

  it('redacts camelCase credential keys the boundary heuristic missed', () => {
    const redacted = redactSecrets({
      clientSecret: 's',
      secretKey: 'k',
      privateKey: 'p',
      passwordHash: 'h',
      authorizationHeader: 'a',
      accessToken: 't',
      apiKey: 'i',
    });

    expect(redacted).toEqual({
      clientSecret: '[REDACTED]',
      secretKey: '[REDACTED]',
      privateKey: '[REDACTED]',
      passwordHash: '[REDACTED]',
      authorizationHeader: '[REDACTED]',
      accessToken: '[REDACTED]',
      apiKey: '[REDACTED]',
    });
  });

  it('does not over-redact benign keys that merely contain "key" or "token"', () => {
    const redacted = redactSecrets({
      tokens: { primary: '#fff' },
      slugKey: 'hero',
      monkey: 'ok',
    });

    expect(redacted).toEqual({ tokens: { primary: '#fff' }, slugKey: 'hero', monkey: 'ok' });
  });
});

describe('theme tokens', () => {
  it('normalizes merged theme settings into manifest token arrays', () => {
    const tokens = parseThemeJsonSettings({
      color: {
        palette: {
          theme: [{ slug: 'primary', name: 'Primary', color: '#0057ff' }, { slug: 'bad' }],
        },
      },
      typography: {
        fontFamilies: [{ slug: 'body', fontFamily: 'Inter, sans-serif' }],
        fontSizes: [{ slug: 'large', size: '2rem' }],
      },
      spacing: { spacingSizes: [{ slug: '40', size: '1rem' }] },
    });

    expect(tokens).toEqual({
      colors: [{ slug: 'primary', name: 'Primary', value: '#0057ff' }],
      spacing: [{ slug: '40', value: '1rem' }],
      typography: [
        { slug: 'body', value: 'Inter, sans-serif' },
        { slug: 'large', value: '2rem' },
      ],
    });
  });
});

describe('summary', () => {
  it('returns structured counts without prose snapshots', () => {
    const manifest = validate(fixture()).context;
    expect(manifest).toBeDefined();

    const summary = summarize(manifest as SiteContext);

    expect(summary.counts).toMatchObject({
      blockTypes: 1,
      bindingSources: 1,
      postTypes: 1,
      bindableFields: 2,
      patterns: 1,
      plugins: 1,
      imageSizes: 1,
      warnings: 0,
    });
    expect(summary.bindingReadiness.fieldsByPostType).toEqual({ post: 2 });
  });

  it('reports present-empty sections as zero', () => {
    const manifest = validate(fixture({ patterns: { items: [] } })).context;
    expect(manifest).toBeDefined();

    const summary = summarize(manifest as SiteContext);

    expect(summary.counts.patterns).toBe(0);
  });

  it('reports absent sections distinctly in markdown', () => {
    const manifest = fixture({
      warnings: [
        {
          code: 'patterns.unavailable',
          severity: 'warning',
          surface: 'patterns',
          message: 'Patterns could not be collected.',
        },
      ],
    });
    delete manifest.patterns;
    const context = validate(manifest).context;
    expect(context).toBeDefined();

    expect(formatSummaryMarkdown(context as SiteContext)).toContain('- Patterns: absent (see warnings)');
  });
});

describe('manifest serialization', () => {
  it('emits $schema and contextVersion first without changing sourceHash semantics', () => {
    const context = validate(fixture()).context as SiteContext;
    const serialized = stringifyManifest(context);

    expect(serialized.startsWith('{\n  "$schema"')).toBe(true);
    expect(serialized.split('\n')[2]).toContain('"contextVersion"');
    expect(sourceHash(JSON.parse(serialized))).toBe(sourceHash(context));
  });
});

describe('package metadata', () => {
  it('does not advertise deferred V1.1 surfaces as shipped V1 features', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      description: string;
      keywords: string[];
    };
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const publicMetadata = `${packageJson.description} ${packageJson.keywords.join(' ')} ${readme}`;

    // REST shipped in this build (it is now a supported collector), so it is no longer
    // a deferred surface. The rest remain V1.1-deferred and must not be advertised as V1.
    expect(publicMetadata).not.toMatch(/\b(?:abilities|mcp|acf|diff|freshness|ttl)\b/i);
  });
});

function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    $schema: SCHEMA_URL,
    contextVersion: 1,
    site: { url: 'https://example.test', name: 'Example', environment: 'local', isMultisite: false },
    provenance: {
      collectedAt: '2026-06-25T00:00:00.000Z',
      collector: 'fixture',
      collectorVersion: '0.1.0',
      sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      partial: false,
    },
    wordpress: {
      version: '6.9',
      locale: 'en_US',
      permalinkStructure: '/%postname%/',
      features: { blockBindings: true, blockBindingsSupportedAttributesApi: true, patterns: true },
    },
    theme: {
      stylesheet: 'example',
      template: 'example',
      name: 'Example',
      version: '1.0.0',
      isBlockTheme: true,
      settingsOrigin: 'merged',
      tokens: { colors: [], spacing: [], typography: [] },
      settings: {},
    },
    plugins: [{ slug: 'example/example.php', name: 'Example', version: '1.0.0', active: true }],
    blocks: { types: [{ name: 'core/paragraph', attributes: {}, supports: {}, source: 'core' }] },
    bindings: {
      available: true,
      sources: [{ name: 'core/post-meta', label: 'Post Meta', usesContext: ['postId', 'postType'], argsSchema: null }],
      supportedAttributes: { 'core/paragraph': ['content'] },
      warnings: [],
    },
    contentModel: {
      postTypes: [
        {
          name: 'post',
          label: 'Posts',
          public: true,
          showInRest: true,
          taxonomies: ['category'],
          fields: [
            {
              name: 'date',
              key: 'date',
              source: 'core/post-data',
              args: { field: 'date' },
              type: 'string',
              bindable: true,
            },
            {
              name: 'price',
              key: 'price',
              source: 'core/post-meta',
              args: { key: 'price' },
              type: 'number',
              single: true,
              showInRest: true,
              bindable: true,
            },
          ],
        },
      ],
    },
    patterns: { items: [{ name: 'example/hero', title: 'Hero' }] },
    media: { imageSizes: [{ name: 'large', width: 1024, height: 1024, crop: false }], maxUploadSize: 10485760 },
    warnings: [],
  };

  return deepMerge(base, overrides);
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
