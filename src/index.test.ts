import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalize, sourceHash } from './canonical.js';
import { normalizeCollectorOutput } from './collector/normalize.js';
import { MAX_REDACTION_DEPTH, redactSecrets } from './redact.js';
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

  it('requires complete plugin, block, image-size, and field records', () => {
    const result = validate(
      fixture({
        plugins: [{ slug: '   ' }],
        blocks: { types: [{ name: 'core/paragraph' }] },
        media: { imageSizes: [{ name: 'large', width: 1024, height: 1024 }] },
        contentModel: {
          postTypes: [{ name: 'post', fields: [{ name: 'date', source: 'core/post-data', args: { field: 'date' } }] }],
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining([
        'plugins.0.slug',
        'plugins.0.name',
        'plugins.0.active',
        'blocks.types.0.attributes',
        'blocks.types.0.supports',
        'blocks.types.0.source',
        'media.imageSizes.0.crop',
        'contentModel.postTypes.0.fields.0.bindable',
      ]),
    );
  });

  it('rejects duplicate V1 identifiers with the duplicate path and code', () => {
    const result = validate(
      fixture({
        plugins: [
          { slug: 'example/example.php', name: 'Example', active: true },
          { slug: 'example/example.php', name: 'Example copy', active: false },
        ],
        blocks: {
          types: [
            { name: 'core/paragraph', attributes: {}, supports: {}, source: 'core' },
            { name: 'core/paragraph', attributes: {}, supports: {}, source: 'core' },
          ],
        },
        media: {
          imageSizes: [
            { name: 'large', width: 1024, height: 1024, crop: false },
            { name: 'large', width: 512, height: 512, crop: false },
          ],
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'manifest.duplicate_identifier', path: 'plugins.1.slug' }),
        expect.objectContaining({ code: 'manifest.duplicate_identifier', path: 'blocks.types.1.name' }),
        expect.objectContaining({ code: 'manifest.duplicate_identifier', path: 'media.imageSizes.1.name' }),
      ]),
    );
  });

  it('scopes field identifiers to their binding source', () => {
    const fields = [
      { name: 'date', key: 'date', source: 'core/post-data', args: { field: 'date' }, type: 'string', bindable: true },
      { name: 'date', key: 'date', source: 'core/post-meta', args: { key: 'date' }, type: 'string', bindable: true },
    ];
    const valid = validate(fixture({ contentModel: { postTypes: [{ name: 'post', fields }] } }));

    expect(valid.ok).toBe(true);

    const invalid = validate(fixture({
      contentModel: {
        postTypes: [{
          name: 'post',
          fields: [...fields, { name: 'date', key: 'date', source: 'core/post-data', args: { field: 'date' }, type: 'string', bindable: true }],
        }],
      },
    }));
    expect(invalid.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'manifest.duplicate_identifier', path: 'contentModel.postTypes.0.fields.2.name' }),
      expect.objectContaining({ code: 'manifest.duplicate_identifier', path: 'contentModel.postTypes.0.fields.2.key' }),
    ]));
  });

  it('requires bindable fields to reference a reported binding source', () => {
    const omittedRegistry = fixture();
    delete omittedRegistry.bindings;

    expect(validate(omittedRegistry).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'bindings.missing_source', path: 'contentModel.postTypes.0.fields.0.source' }),
        expect.objectContaining({ code: 'bindings.missing_source', path: 'contentModel.postTypes.0.fields.1.source' }),
      ]),
    );

    const missingSource = validate(
      fixture({
        bindings: {
          available: true,
          sources: [{ name: 'core/post-data', usesContext: [], argsSchema: null }],
          supportedAttributes: {},
        },
      }),
    );
    expect(missingSource.errors).toContainEqual(
      expect.objectContaining({ code: 'bindings.missing_source', path: 'contentModel.postTypes.0.fields.1.source' }),
    );

    const reportedSource = validate(fixture());
    expect(reportedSource.ok).toBe(true);
  });

  it('validates core binding arguments and availability relationships', () => {

    const invalidCoreArguments = validate(
      fixture({
        contentModel: {
          postTypes: [
            {
              name: 'post',
              fields: [{ name: 'date', source: 'core/post-data', args: { field: 'title' }, bindable: true }],
            },
          ],
        },
      }),
    );
    expect(invalidCoreArguments.errors).toContainEqual(
      expect.objectContaining({
        code: 'bindings.invalid_core_source_argument',
        path: 'contentModel.postTypes.0.fields.0.args.field',
      }),
    );

    const unavailable = validate(fixture({ bindings: { available: false } }));
    expect(unavailable.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'bindings.unavailable_evidence', path: 'bindings.sources' }),
        expect.objectContaining({ code: 'bindings.unavailable_evidence', path: 'bindings.supportedAttributes' }),
        expect.objectContaining({ code: 'bindings.unavailable_field', path: 'contentModel.postTypes.0.fields.0.bindable' }),
      ]),
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

  it('sanitises credentials in warning messages before validation and serialization', () => {
    const password = 'synthetic-validated-warning-password';
    const authorization = 'Basic synthetic-validated-warning-authorization';
    const manifest = fixture({
      warnings: [
        {
          code: 'collector.partial',
          severity: 'warning',
          surface: 'site',
          message: `Application Password: ${password}; Authorization: ${authorization}`,
        },
      ],
    });

    const result = validate(manifest);
    const serialized = stringifyManifest(manifest as SiteContext);

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.context)).not.toContain(password);
    expect(JSON.stringify(result.context)).not.toContain(authorization);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(authorization);
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

  it('keeps missing raw evidence from becoming complete through schema defaults', () => {
    const result = validate({
      contextVersion: 1,
      site: {},
      provenance: {
        collectedAt: '2026-06-25T00:00:00.000Z',
        collector: 'fixture',
        collectorVersion: 'test',
        sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
      warnings: [],
      blocks: {},
      bindings: { available: true },
      contentModel: {},
    });

    expect(result.ok).toBe(true);
    const context = result.context as SiteContext;
    const summary = summarize(context);

    expect(context.provenance.partial).toBe(true);
    expect(summary.coverage).toMatchObject({
      blocks: 'partial',
      bindings: 'partial',
      contentModel: 'partial',
    });
    expect(summary.supportedWork).not.toContain(
      'Create bindings by joining the reported block attributes with the reported post-type fields.',
    );
    expect(summary.unknownWork).toEqual(
      expect.arrayContaining([expect.stringContaining('Complete binding work is not supported until')]),
    );
    expect(context.provenance.sourceHash).toBe(
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    );
    expect(sourceHash(context)).not.toBe(context.provenance.sourceHash);

    const roundTrip = validate(JSON.parse(stringifyManifest(context)));
    expect(roundTrip.ok).toBe(true);
    expect(roundTrip.context?.provenance.sourceHash).toBe(context.provenance.sourceHash);
  });

  it('keeps explicit unavailable bindings distinct from missing binding discovery', () => {
    const result = validate({
      contextVersion: 1,
      site: {},
      provenance: {
        collectedAt: '2026-06-25T00:00:00.000Z',
        collector: 'fixture',
        collectorVersion: 'test',
        sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
      warnings: [],
      blocks: { types: [] },
      bindings: { available: false },
      contentModel: { postTypes: [] },
    });

    expect(result.ok).toBe(true);
    expect(summarize(result.context as SiteContext).coverage.bindings).toBe('unavailable');
    expect(result.context?.warnings).not.toContainEqual(expect.objectContaining({ code: 'bindings.invalid_evidence' }));
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
      code: 'patterns.absent_evidence',
      severity: 'warning',
      surface: 'patterns',
      message: 'The manifest omits patterns evidence; the surface is unavailable rather than empty.',
      coverage: 'unavailable',
    });
  });

  it('keeps schema validity separate from source-hash integrity', () => {
    const manifest = fixture();
    (manifest.provenance as Record<string, unknown>).sourceHash = sourceHash(manifest);
    (manifest.site as Record<string, unknown>).name = 'Changed after collection';

    const result = validate(manifest);

    // validate() accepts structurally valid documents; callers opt in to this
    // explicit comparison when they need to attest content integrity.
    expect(result.ok).toBe(true);
    expect(result.context).toBeDefined();
    expect(sourceHash(result.context)).not.toBe(result.context?.provenance.sourceHash);
  });
});

describe('sourceHash and redaction', () => {
  it('canonicalizes object keys by RFC 8785 code-unit order regardless of process locale', () => {
    const originalLang = process.env.LANG;
    const value = { Z: true, a: true, _internal: true, '2': true, '10': true };

    try {
      const expected = '{"10":true,"2":true,"Z":true,"_internal":true,"a":true}';
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

  it('matches the RFC 8785 UTF-16 member-name sorting vector', () => {
    const value = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    };

    expect(canonicalize(value)).toBe(
      '{"\\r":"Carriage Return","1":"One","":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it('matches RFC 8785 number and string serialization examples', () => {
    expect(
      canonicalize({
        numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27, -0],
        string: "€$\u000f\nA'B\"\\\"/",
        literals: [null, true, false],
      }),
    ).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0],"string":"€$\\u000f\\nA\'B\\\"\\\\\\\"/"}',
    );
  });

  it('matches every finite RFC 8785 Appendix B number serialization vector', () => {
    const finiteVectors = [
      ['0000000000000000', '0'],
      ['8000000000000000', '0'],
      ['0000000000000001', '5e-324'],
      ['8000000000000001', '-5e-324'],
      ['7fefffffffffffff', '1.7976931348623157e+308'],
      ['ffefffffffffffff', '-1.7976931348623157e+308'],
      ['4340000000000000', '9007199254740992'],
      ['c340000000000000', '-9007199254740992'],
      ['4430000000000000', '295147905179352830000'],
      ['44b52d02c7e14af5', '9.999999999999997e+22'],
      ['44b52d02c7e14af6', '1e+23'],
      ['44b52d02c7e14af7', '1.0000000000000001e+23'],
      ['444b1ae4d6e2ef4e', '999999999999999700000'],
      ['444b1ae4d6e2ef4f', '999999999999999900000'],
      ['444b1ae4d6e2ef50', '1e+21'],
      ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
      ['3eb0c6f7a0b5ed8d', '0.000001'],
      ['41b3de4355555553', '333333333.3333332'],
      ['41b3de4355555554', '333333333.33333325'],
      ['41b3de4355555555', '333333333.3333333'],
      ['41b3de4355555556', '333333333.3333334'],
      ['41b3de4355555557', '333333333.33333343'],
      ['becbf647612f3696', '-0.0000033333333333333333'],
      ['43143ff3c1cb0959', '1424953923781206.2'],
    ] as const;

    for (const [ieee754, serialized] of finiteVectors) {
      expect(canonicalize(numberFromIeee754Hex(ieee754))).toBe(serialized);
    }
  });

  it('rejects values outside the RFC 8785 JSON data model', () => {
    expect(() => canonicalize({ value: Number.NaN })).toThrow('finite numbers');
    expect(() => canonicalize({ value: Number.POSITIVE_INFINITY })).toThrow('finite numbers');
    expect(() => canonicalize({ value: '\ud800' })).toThrow('lone surrogate');
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

  it('sanitises URL userinfo before validation, hashing, and serialization', () => {
    const password = 'synthetic-url-app-password';
    const credentialUrl = `https://synthetic-user:${password}@example.test/wp-json/`;
    const redactedUrl = 'https://%5BREDACTED%5D@example.test/wp-json/';
    const result = validate(fixture({ site: { url: credentialUrl } }));

    expect(result.ok).toBe(true);
    expect(result.context?.site.url).toBe(redactedUrl);
    expect(canonicalize({ site: { url: credentialUrl } })).not.toContain(password);
    expect(sourceHash({ site: { url: credentialUrl } })).toBe(sourceHash({ site: { url: redactedUrl } }));
    expect(stringifyManifest(fixture({ site: { url: credentialUrl } }) as SiteContext)).not.toContain(password);
  });

  it('turns excessively nested manifest input into a bounded validation failure', () => {
    let nested: unknown = { value: 'safe' };
    for (let depth = 0; depth <= MAX_REDACTION_DEPTH; depth += 1) {
      nested = { nested };
    }

    const result = validate(nested);

    expect(result).toMatchObject({
      ok: false,
      errors: [{ path: '<root>', message: expect.stringContaining('Redaction refused input nested') }],
      warnings: [],
    });
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

    expect(tokens.colors[0]).toMatchObject({ id: 'color:primary', kind: 'color', label: 'Primary', value: '#0057ff' });
    expect(tokens.colors[0]?.references.blockStyle).toBe('var:preset|color|primary');
    expect(tokens.fontFamilies[0]).toMatchObject({ id: 'font-family:body', kind: 'font-family', value: 'Inter, sans-serif' });
    expect(tokens.fontSizes[0]).toMatchObject({ id: 'font-size:large', kind: 'font-size', value: '2rem' });
    expect(tokens.spacing[0]).toMatchObject({ id: 'spacing:40', kind: 'spacing', value: '1rem' });
  });

  it('keeps provenance stable when preset origins with the same slug are reordered', () => {
    const settings = (reversed: boolean) => ({
      color: {
        palette: reversed
          ? {
              user: [{ slug: 'primary', name: 'User primary', color: '#cc0000' }],
              theme: [{ slug: 'primary', name: 'Theme primary', color: '#0057ff' }],
            }
          : {
              theme: [{ slug: 'primary', name: 'Theme primary', color: '#0057ff' }],
              user: [{ slug: 'primary', name: 'User primary', color: '#cc0000' }],
            },
      },
    });
    const normalize = (themeSettings: Record<string, unknown>) =>
      normalizeCollectorOutput(
        { site: {}, theme: { settings: themeSettings }, warnings: [] },
        { collector: 'wp-cli', collectorVersion: 'test' },
      );

    const first = normalize(settings(false));
    const second = normalize(settings(true));

    expect(first.theme?.themeJsonHash).toBe(second.theme?.themeJsonHash);
    expect(first.theme?.tokens?.colors).toMatchObject([
      { id: 'color:primary', label: 'User primary', value: '#cc0000', origin: 'user' },
    ]);
    expect(second.theme?.tokens).toEqual(first.theme?.tokens);
    expect(first.provenance.sourceHash).toBe(second.provenance.sourceHash);
  });

  it('uses verified origin precedence without inventing semantic roles', () => {
    const tokens = parseThemeJsonSettings({
      color: { palette: {
        default: [{ slug: 'brand', name: 'Core brand', color: '#111' }],
        theme: [{ slug: 'brand', name: 'Theme brand', color: '#222' }],
        user: [{ slug: 'brand', name: 'Editorial blue', color: '#333' }],
        experimental: [{ slug: 'plain', color: '#444' }],
      } },
      typography: {
        fontFamilies: [{ slug: 'shared', name: 'Reading', fontFamily: 'Georgia, serif' }],
        fontSizes: [{ slug: 'shared', name: 'Display', size: '3rem' }],
      },
    });

    expect(tokens.colors).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'brand', label: 'Editorial blue', value: '#333', origin: 'user' }),
      expect.objectContaining({ slug: 'plain', origin: 'unknown' }),
    ]));
    expect(tokens.fontFamilies[0]).toMatchObject({ id: 'font-family:shared', label: 'Reading' });
    expect(tokens.fontSizes[0]).toMatchObject({ id: 'font-size:shared', label: 'Display' });
    expect(tokens.presets.map((token) => token.id)).toEqual(expect.arrayContaining(['font-family:shared', 'font-size:shared']));
  });

  it('uses WordPress-normalized preset slugs for references and deduplication', () => {
    const tokens = parseThemeJsonSettings({
      color: { palette: {
        theme: [{ slug: 'Brand Primary', color: '#111' }],
        user: [{ slug: 'brand-primary', color: '#222' }],
      } },
    });

    expect(tokens.colors).toEqual([
      expect.objectContaining({
        id: 'color:brand-primary', slug: 'brand-primary', value: '#222', origin: 'user',
        references: expect.objectContaining({ cssCustomProperty: '--wp--preset--color--brand-primary', blockStyle: 'var:preset|color|brand-primary' }),
      }),
    ]);
  });

  it('uses the final declaration when normalized slugs collide at one origin', () => {
    const tokens = parseThemeJsonSettings({
      color: { palette: { theme: [
        { slug: 'BrandPrimary', color: '#111' },
        { slug: 'brand-primary', color: '#222' },
      ] } },
    });

    expect(tokens.colors).toEqual([expect.objectContaining({ slug: 'brand-primary', value: '#222' })]);
  });

  it('matches WordPress ordinal slug normalization', () => {
    const tokens = parseThemeJsonSettings({
      color: { palette: [{ slug: '1stHeading', color: '#111' }] },
    });

    expect(tokens.colors).toEqual([expect.objectContaining({ slug: '1st-heading' })]);
  });

  it('uses WordPress-resolved font-size values when the collector provides them', () => {
    const settings = {
      typography: {
        fluid: true,
        fontSizes: { theme: [{ slug: 'Display XL', size: '4rem', fluid: { min: '2rem', max: '4rem' } }] },
      },
    };
    const tokens = parseThemeJsonSettings(settings, { theme: ['clamp(2rem, 1rem + 1vw, 4rem)'] });

    expect(tokens.fontSizes).toEqual([
      expect.objectContaining({ slug: 'display-xl', value: 'clamp(2rem, 1rem + 1vw, 4rem)', valueSource: 'resolved' }),
    ]);
  });

  it('preserves unavailable theme settings as absent evidence', () => {
    const context = normalizeCollectorOutput(
      { site: {}, theme: { stylesheet: 'example' }, warnings: [] },
      { collector: 'wp-cli', collectorVersion: 'test' },
    );

    expect(context.theme).toEqual(expect.objectContaining({ stylesheet: 'example' }));
    expect(context.theme).not.toHaveProperty('settings');
    expect(context.theme).not.toHaveProperty('settingsOrigin');
    expect(context.theme).not.toHaveProperty('tokens');
    expect(context.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'theme.settings_unavailable', coverage: 'partial' }),
    ]));
  });

  it('marks a missing site surface unavailable even when every other collector surface is complete', () => {
    const context = normalizeCollectorOutput(
      {
        wordpress: {},
        theme: { settings: {} },
        plugins: [],
        blocks: { types: [] },
        bindings: { available: true, sources: [], supportedAttributes: {}, warnings: [] },
        contentModel: { postTypes: [] },
        patterns: { items: [] },
        media: { imageSizes: [] },
        warnings: [
          {
            code: 'site.unavailable',
            severity: 'warning',
            surface: 'site',
            message: 'Site metadata was not returned by the collector.',
            coverage: 'unavailable',
          },
        ],
      },
      { collector: 'wp-cli', collectorVersion: 'test' },
    );

    expect(context.provenance.partial).toBe(true);
    expect(summarize(context).coverage.site).toBe('unavailable');
    const roundTrip = validate(JSON.parse(stringifyManifest(context)));
    expect(roundTrip.context?.provenance.sourceHash).toBe(context.provenance.sourceHash);
  });

  it('materializes omitted collector evidence before hashing so validation does not alter the document', () => {
    const context = normalizeCollectorOutput(
      { site: {}, warnings: [] },
      { collector: 'wp-cli', collectorVersion: 'test' },
    );

    expect(context.warnings).toContainEqual({
      code: 'blocks.absent_evidence',
      severity: 'warning',
      surface: 'blocks',
      message: 'The collector omitted blocks evidence; the surface is unavailable rather than empty.',
      coverage: 'unavailable',
    });
    expect(context.provenance.partial).toBe(true);

    const serialized = stringifyManifest(context);
    const validated = validate(JSON.parse(serialized));
    expect(validated.context?.provenance.sourceHash).toBe(context.provenance.sourceHash);
    expect(stringifyManifest(validated.context as SiteContext)).toBe(serialized);
  });
});

describe('summary', () => {
  it('returns structured counts without prose snapshots', () => {
    const manifest = validate(fixture()).context;
    expect(manifest).toBeDefined();

    const summary = summarize(manifest as SiteContext);

    expect(summary.counts).toMatchObject({
      blockTypes: 1,
      bindingSources: 2,
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

  it('groups prototype-named warning surfaces as ordinary own keys', () => {
    const context = validate(
      fixture({
        warnings: [
          {
            code: 'collector.constructor',
            severity: 'warning',
            surface: 'constructor',
            message: 'Constructor-named surface.',
          },
          {
            code: 'collector.proto',
            severity: 'warning',
            surface: '__proto__',
            message: 'Prototype-named surface.',
          },
        ],
      }),
    ).context as SiteContext;

    const summary = summarize(context);

    expect(Object.getPrototypeOf(summary.warningsBySurface)).toBeNull();
    expect(Object.hasOwn(summary.warningsBySurface, 'constructor')).toBe(true);
    expect(Object.hasOwn(summary.warningsBySurface, '__proto__')).toBe(true);
    expect(summary.warningsBySurface.constructor).toHaveLength(1);
    expect(summary.warningsBySurface.__proto__).toHaveLength(1);
    expect(formatSummaryMarkdown(context)).toContain('- __proto__: [collector.proto] Prototype-named surface.');
  });

  it('separates complete, partial, and unavailable evidence from its counts', () => {
    const manifest = fixture({
      blocks: { types: [] },
      bindings: {
        available: true,
        sources: [],
        supportedAttributes: {},
        warnings: [
          {
            code: 'bindings.supported_attributes_partial',
            severity: 'info',
            surface: 'bindings.supportedAttributes',
            message: 'Only some supported attributes were reported.',
            coverage: 'partial',
          },
        ],
      },
      contentModel: { postTypes: [] },
      warnings: [
        {
          code: 'patterns.rest_unavailable',
          severity: 'info',
          surface: 'patterns',
          message: 'Patterns could not be collected.',
          coverage: 'unavailable',
        },
      ],
    });
    delete manifest.patterns;
    const context = validate(manifest).context;
    expect(context).toBeDefined();

    const summary = summarize(context as SiteContext);

    expect(summary.counts).toMatchObject({ blockTypes: 0, bindingSources: 0, postTypes: 0, patterns: 'absent' });
    expect(summary.coverage).toMatchObject({
      blocks: 'complete',
      bindings: 'partial',
      contentModel: 'complete',
      patterns: 'unavailable',
    });
    expect(summary.supportedWork).toContain('Use only the reported binding sources and supported block attributes; binding evidence is incomplete.');
    expect(summary.unknownWork).toContain(
      'Complete binding work is not supported until binding source and supported-attribute evidence is complete.',
    );
    expect(summary.unknownWork).toContain('Block pattern evidence is unavailable; do not assume the surface is empty.');

    const markdown = formatSummaryMarkdown(context as SiteContext);
    expect(markdown).toContain('## Evidence');
    expect(markdown).toContain('### Coverage');
    expect(markdown).toContain('- bindings: partial');
    expect(markdown).toContain('### Supported Work');
    expect(markdown).toContain('### Remaining Unknowns');
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

function numberFromIeee754Hex(hex: string): number {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setBigUint64(0, BigInt(`0x${hex}`), false);
  return view.getFloat64(0, false);
}

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
      sources: [
        { name: 'core/post-data', label: 'Post Data', usesContext: ['postId', 'postType'], argsSchema: null },
        { name: 'core/post-meta', label: 'Post Meta', usesContext: ['postId', 'postType'], argsSchema: null },
      ],
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
