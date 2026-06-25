import { describe, expect, it } from 'vitest';
import { sourceHash } from './canonical.js';
import { redactSecrets } from './redact.js';
import { parseThemeJsonSettings } from './theme.js';
import { SCHEMA_URL, type SiteContext } from './types.js';
import { summarize, validate } from './index.js';

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
});

describe('sourceHash and redaction', () => {
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
            { key: 'title', source: 'core/post-data', type: 'string', bindable: true },
            { key: 'price', source: 'core/post-meta', type: 'number', single: true, showInRest: true, bindable: true },
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
