import { execFile, execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectorSourceForTests } from './wpcli.js';
import { normalizeCollectorOutput } from './normalize.js';
import { collect, sourceHash, stringifyManifest, validate } from '../index.js';
import { coverageFor, strictCoverageGaps } from '../warnings.js';

let mockedOutput = wpOutput();
let mockedError: Error | null = null;
let mockedStdout: string | undefined;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((_file, _args, _options, callback) => {
      callback(mockedError, { stdout: mockedStdout ?? JSON.stringify(mockedOutput), stderr: '' });
    }),
  };
});

describe('WP-CLI collector', () => {
  afterEach(() => {
    mockedOutput = wpOutput();
    mockedError = null;
    mockedStdout = undefined;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('uses execFile argv rather than shell interpolation', async () => {
    const context = await collect({
      collector: 'wp-cli',
      wpPath: '/tmp/wp',
      wpUrl: 'https://example.test',
      ssh: 'example',
      wpBinary: 'wp',
    });

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      'wp',
      expect.arrayContaining(['--ssh=example', '--path=/tmp/wp', '--url=https://example.test', 'eval']),
      expect.objectContaining({ encoding: 'utf8' }),
      expect.any(Function),
    );
    expect(context.bindings?.supportedAttributes['core/paragraph']).toEqual(['content']);
    expect(context.theme?.tokens?.colors[0]).toMatchObject({ id: 'color:primary', value: '#0057ff' });
    expect(context.provenance.partial).toBe(false);
  });

  it('keeps unavailable global settings absent instead of serializing an authoritative empty array', () => {
    const source = collectorSourceForTests();

    expect(source).toContain("$settings = function_exists('wp_get_global_settings') ? wp_get_global_settings() : null;");
    expect(source).toContain("if (is_array($settings)) {");
  });

  it('uses WordPress to resolve the CSS value of font-size presets', () => {
    const source = collectorSourceForTests();

    expect(source).toContain("wp_get_typography_font_size_value($preset, $settings)");
    expect(source).toContain("$theme_data['fontSizeValues'] = $font_size_values;");
  });

  it('rejects URL userinfo before it enters WP-CLI argv', async () => {
    const password = 'synthetic-wpcli-app-password';

    await expect(
      collect({ collector: 'wp-cli', wpPath: '/tmp/wp', wpUrl: `https://synthetic-user:${password}@example.test` }),
    ).rejects.toThrow('--wp-url must not contain URL credentials.');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('does not expose failing WP-CLI command arguments', async () => {
    const password = 'synthetic-command-password';
    mockedError = new Error(`Command failed: wp --url=https://synthetic-user:${password}@example.test eval`);

    let failure: Error | undefined;
    try {
      await collect({ collector: 'wp-cli', wpPath: '/tmp/wp', wpUrl: 'https://example.test' });
    } catch (error) {
      failure = error as Error;
    }

    expect(failure).toMatchObject({
      code: 'WESPER_TRANSPORT',
      message: 'Collector failed: WP-CLI collector failed to run. Check WP-CLI availability and collector options.',
    });
    expect(failure?.message).not.toContain(password);
  });

  it('does not expose malformed collector output in parser failures', async () => {
    const password = 'synthetic-collector-output-password';
    mockedStdout = `{\"error\": \"Authorization: Basic ${password}\"`;

    let failure: Error | undefined;
    try {
      await collect({ collector: 'wp-cli', wpPath: '/tmp/wp' });
    } catch (error) {
      failure = error as Error;
    }

    expect(failure).toMatchObject({
      code: 'WESPER_TRANSPORT',
      message: 'Collector failed: WP-CLI collector returned malformed JSON.',
    });
    expect(failure?.message).not.toContain(password);
  });

  it('rejects unclassified binding evidence warnings in strict mode', async () => {
    mockedOutput = {
      ...wpOutput(),
      warnings: [
        {
          code: 'bindings.read_failed',
          severity: 'info',
          surface: 'bindings',
          message: 'Binding source evidence could not be read.',
        },
      ],
    };

    await expect(collect({ collector: 'wp-cli', wpPath: '/tmp/wp', strict: true })).rejects.toMatchObject({
      code: 'WESPER_STRICT_POLICY',
      message: expect.stringContaining('bindings (partial)'),
    });
    await expect(collect({ collector: 'wp-cli', wpPath: '/tmp/wp' })).resolves.toMatchObject({
      provenance: { partial: true },
    });
  });

  it('preserves omitted raw surfaces instead of fabricating empty sections', async () => {
    mockedOutput = {
      ...wpOutput(),
      warnings: [
        {
          code: 'patterns.unavailable',
          severity: 'warning',
          surface: 'patterns',
          message: 'Patterns could not be collected.',
        },
      ],
    };
    delete mockedOutput.patterns;

    const context = await collect({ collector: 'wp-cli', wpPath: '/tmp/wp' });

    expect(context.patterns).toBeUndefined();
    expect(context.warnings).toContainEqual({
      code: 'patterns.unavailable',
      severity: 'warning',
      surface: 'patterns',
      message: 'Patterns could not be collected.',
    });
  });

  it('does not normalize malformed collector data as successful empty evidence', () => {
    const context = normalizeCollectorOutput(
      {
        site: { environment: 'local', isMultisite: false },
        blocks: {},
        bindings: { available: true },
        contentModel: { postTypes: [{ name: 'post' }] },
        warnings: [],
      },
      { collector: 'wp-cli', collectorVersion: 'test' },
    );

    expect(context.blocks).toBeUndefined();
    expect(context.bindings).toBeUndefined();
    expect(context.contentModel).toBeUndefined();
    expect(context.provenance.partial).toBe(true);
    expect(context.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['blocks.invalid_evidence', 'bindings.invalid_evidence', 'contentModel.invalid_evidence']),
    );
  });

  it('normalizes only explicit PHP empty-array dictionary transport values', () => {
    const context = normalizeCollectorOutput(
      {
        site: {},
        blocks: { types: [{ name: 'test/block', attributes: [], supports: [], source: 'plugin' }] },
        bindings: { available: true, sources: [], supportedAttributes: [], warnings: [] },
        contentModel: { postTypes: [] },
        warnings: [],
      },
      { collector: 'wp-cli', collectorVersion: 'test' },
    );

    expect(context.blocks?.types[0]).toMatchObject({ attributes: {}, supports: {} });
    expect(context.bindings?.supportedAttributes).toEqual({});
    expect(validate(JSON.parse(stringifyManifest(context))).ok).toBe(true);
    expect(context.provenance.sourceHash).toBe(sourceHash(context));

    expect(() => normalizeCollectorOutput(
      {
        site: {},
        blocks: { types: [{ name: 'test/block', attributes: ['not-a-map'], supports: {}, source: 'plugin' }] },
        warnings: [],
      },
      { collector: 'wp-cli', collectorVersion: 'test' },
    )).toThrow();
  });

  it('serializes PHP empty dictionary boundaries as JSON objects', () => {
    const helper = collectorSourceForTests().match(/function wesper_json_map\(\$value\) \{[\s\S]*?\n\}/)?.[0];
    expect(helper).toBeDefined();

    const output = execFileSync(
      '/opt/homebrew/bin/php',
      ['-r', `${helper}\necho json_encode(array('attributes' => wesper_json_map(array()), 'supports' => wesper_json_map(array()), 'supportedAttributes' => wesper_json_map(array())));`],
      { encoding: 'utf8' },
    );

    expect(JSON.parse(output)).toEqual({ attributes: {}, supports: {}, supportedAttributes: {} });
  });

  it('does not default missing nested binding-source evidence to empty/null', () => {
    const context = normalizeCollectorOutput(
      {
        site: { environment: 'local', isMultisite: false },
        blocks: { types: [] },
        bindings: {
          available: true,
          sources: [{ name: 'acme/incomplete-source' }],
          supportedAttributes: {},
          warnings: [],
        },
        contentModel: { postTypes: [] },
        warnings: [],
      },
      { collector: 'wp-cli', collectorVersion: 'test' },
    );

    expect(context.bindings).toBeUndefined();
    expect(context.warnings).toContainEqual({
      code: 'bindings.invalid_evidence',
      severity: 'warning',
      surface: 'bindings',
      coverage: 'partial',
      message: expect.any(String),
    });
    expect(context.provenance.partial).toBe(true);
    expect(coverageFor(context, ['bindings'])).toMatchObject([{ status: 'partial' }]);
    expect(strictCoverageGaps(context)).toContainEqual(expect.objectContaining({ surface: 'bindings', status: 'partial' }));
  });

  it('uses names from WordPress indexed registry records', async () => {
    mockedOutput = {
      ...wpOutput(),
      // WP_Block_Patterns_Registry::get_all_registered() returns an indexed list.
      patterns: {
        items: [
          { name: 'example/banner', title: 'Banner' },
          { name: 'plugin/call-to-action', title: 'Call to action' },
        ],
      },
    };

    const context = await collect({ collector: 'wp-cli', wpPath: '/tmp/wp' });
    const source = collectorSourceForTests();

    expect(context.patterns?.items.map((item) => item.name)).toEqual(['example/banner', 'plugin/call-to-action']);
    expect(source).toContain('get_all_registered() as $pattern)');
    expect(source).toContain("'name' => $pattern['name']");
    expect(source).toContain("!is_string($pattern['name'])");
    expect(source).toContain("'patterns.invalid_identifier'");
    expect(source).not.toContain('get_all_registered() as $name => $pattern)');
  });

  it('preserves the same pattern identifiers as REST for equivalent patterns', async () => {
    const patterns = [
      { name: 'example/banner', title: 'Banner', categories: ['featured'], blockTypes: ['core/group'], postTypes: ['page'] },
      { name: 'plugin/call-to-action', title: 'Call to action', categories: [], blockTypes: [], postTypes: [] },
    ];
    mockedOutput = { ...wpOutput(), patterns: { items: patterns } };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL) => {
        const url = String(input);
        let body: unknown;
        if (url.endsWith('/wp-json/')) {
          body = { name: 'Example' };
        } else if (url.includes('/wp/v2/themes')) {
          body = [];
        } else if (url.includes('/wp/v2/block-types')) {
          body = [];
        } else if (url.includes('/wp/v2/types')) {
          body = {};
        } else if (url.includes('/wp/v2/block-patterns/patterns')) {
          body = patterns.map((pattern) => ({
            name: pattern.name,
            title: pattern.title,
            categories: pattern.categories,
            block_types: pattern.blockTypes,
            post_types: pattern.postTypes,
          }));
        } else {
          return Promise.reject(new Error(`unexpected fetch: ${url}`));
        }
        return Promise.resolve({ ok: true, json: async () => body } as Response);
      }),
    );

    const wpCli = await collect({ collector: 'wp-cli', wpPath: '/tmp/wp' });
    const rest = await collect({ collector: 'rest', wpUrl: 'https://example.test' });

    expect(rest.patterns?.items.map((item) => item.name)).toEqual(wpCli.patterns?.items.map((item) => item.name));
  });

  it('redacts secrets from all normalized collector surfaces before returning a manifest', async () => {
    mockedOutput = {
      ...wpOutput(),
      theme: {
        ...(wpOutput().theme as Record<string, unknown>),
        settings: {
          color: { palette: [{ slug: 'primary', color: '#0057ff' }] },
          custom: { apiKey: 'secret-value' },
        },
      },
      blocks: {
        types: [
          {
            name: 'core/paragraph',
            attributes: { appPassword: 'block-secret' },
            supports: {},
            source: 'core',
          },
        ],
      },
    };

    const context = await collect({ collector: 'wp-cli', wpPath: '/tmp/wp' });
    const serialized = stringifyManifest(context);

    expect(context.theme?.settings).toMatchObject({ custom: { apiKey: '[REDACTED]' } });
    expect(context.blocks?.types[0]).toMatchObject({ attributes: { appPassword: '[REDACTED]' } });
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('block-secret');
  });

  it('sanitises credentials embedded in collector warning messages', async () => {
    const camelCasedPassword = 'synthetic-warning-app-password';
    const groupedPassword = 'abcd efgh ijkl mnop qrst uvwx';
    const authorization = 'Basic synthetic-warning-authorization';
    mockedOutput = {
      ...wpOutput(),
      warnings: [
        {
          code: 'collector.partial',
          severity: 'warning',
          surface: 'site',
          message: `wpAppPassword=${camelCasedPassword}; WP_API_PASSWORD=${groupedPassword}; Authorization: ${authorization}`,
        },
      ],
    };

    const context = await collect({ collector: 'wp-cli', wpPath: '/tmp/wp' });
    const serialized = stringifyManifest(context);

    expect(JSON.stringify(context)).not.toContain(camelCasedPassword);
    expect(JSON.stringify(context)).not.toContain(authorization);
    expect(serialized).not.toContain(camelCasedPassword);
    expect(serialized).not.toContain(authorization);
    for (const group of groupedPassword.split(' ')) {
      expect(JSON.stringify(context)).not.toContain(group);
      expect(serialized).not.toContain(group);
    }
    expect(JSON.stringify(context)).toContain('wpAppPassword: [REDACTED]');
    expect(JSON.stringify(context)).toContain('WP_API_PASSWORD: [REDACTED]');
  });

  it('hashes the final redacted, schema-normalized manifest and survives a JSON validation round trip', async () => {
    mockedOutput = {
      site: { url: 'https://example.test' },
      wordpress: {},
      theme: { settings: { custom: { apiKey: 'theme-secret' } } },
      plugins: [{ slug: 'example/example.php', name: 'Example', active: true }],
      blocks: { types: [] },
      bindings: {
        available: true,
        sources: [{ name: 'example/source', usesContext: ['postType', 'postId'] }],
        supportedAttributes: { 'example/block': ['z', 'a'] },
      },
      contentModel: {
        postTypes: [{ name: 'post', fields: [{ name: 'example', source: 'example/source', args: {}, bindable: true }] }],
      },
      patterns: { items: [] },
      media: {},
      warnings: [],
    };

    const context = await collect({ collector: 'wp-cli', wpPath: '/tmp/wp' });
    const validated = validate(JSON.parse(stringifyManifest(context)));

    expect(context.site).toMatchObject({ environment: 'unknown', isMultisite: false });
    expect(context.bindings?.sources[0]).toMatchObject({ usesContext: ['postId', 'postType'], argsSchema: null });
    expect(context.contentModel?.postTypes[0]?.fields[0]?.bindable).toBe(true);
    expect(context.theme?.settings).toEqual({ custom: { apiKey: '[REDACTED]' } });
    expect(context.theme?.themeJsonHash).toBe(sourceHash({ settings: { custom: { apiKey: '[REDACTED]' } } }));
    expect(context.provenance.sourceHash).toBe(sourceHash(context));
    expect(validated.ok).toBe(true);
    expect(validated.context?.provenance.sourceHash).toBe(context.provenance.sourceHash);
    expect(sourceHash(validated.context)).toBe(context.provenance.sourceHash);
  });

  it('normalizes set-like collections but preserves meaningful theme-settings array order', async () => {
    const output = (reverse: boolean): Record<string, unknown> => ({
      ...wpOutput(),
      theme: {
        settings: {
          color: {
            palette: reverse
              ? [{ slug: 'second', color: '#222' }, { slug: 'first', color: '#111' }]
              : [{ slug: 'first', color: '#111' }, { slug: 'second', color: '#222' }],
          },
        },
      },
      plugins: reverse
        ? [{ slug: 'z/z.php', name: 'Zed', active: true }, { slug: 'a/a.php', name: 'Aye', active: true }]
        : [{ slug: 'a/a.php', name: 'Aye', active: true }, { slug: 'z/z.php', name: 'Zed', active: true }],
      blocks: {
        types: reverse
          ? [{ name: 'z/block', attributes: {}, supports: {}, source: 'plugin' }, { name: 'a/block', attributes: {}, supports: {}, source: 'plugin' }]
          : [{ name: 'a/block', attributes: {}, supports: {}, source: 'plugin' }, { name: 'z/block', attributes: {}, supports: {}, source: 'plugin' }],
      },
      bindings: {
        available: true,
        sources: reverse
          ? [{ name: 'z/source', usesContext: ['z', 'a'] }, { name: 'a/source', usesContext: ['z', 'a'] }]
          : [{ name: 'a/source', usesContext: ['a', 'z'] }, { name: 'z/source', usesContext: ['a', 'z'] }],
        supportedAttributes: { 'example/block': reverse ? ['z', 'a'] : ['a', 'z'] },
        warnings: [],
      },
      contentModel: {
        postTypes: [
          {
            name: 'post',
            taxonomies: reverse ? ['z', 'a'] : ['a', 'z'],
            fields: reverse
              ? [
                  { name: 'z', source: 'a/source', args: {}, bindable: true },
                  { name: 'a', source: 'a/source', args: {}, bindable: true },
                ]
              : [
                  { name: 'a', source: 'a/source', args: {}, bindable: true },
                  { name: 'z', source: 'a/source', args: {}, bindable: true },
                ],
          },
        ],
      },
      patterns: {
        items: [
          {
            name: 'example/pattern',
            categories: reverse ? ['z', 'a'] : ['a', 'z'],
            blockTypes: reverse ? ['z/block', 'a/block'] : ['a/block', 'z/block'],
            postTypes: reverse ? ['z', 'a'] : ['a', 'z'],
          },
        ],
      },
      media: {
        imageSizes: reverse
          ? [{ name: 'z', width: 1, height: 1, crop: false }, { name: 'a', width: 1, height: 1, crop: false }]
          : [{ name: 'a', width: 1, height: 1, crop: false }, { name: 'z', width: 1, height: 1, crop: false }],
      },
      warnings: reverse
        ? [
            { code: 'z', severity: 'info', surface: 'example', message: 'z' },
            { code: 'a', severity: 'info', surface: 'example', message: 'a' },
          ]
        : [
            { code: 'a', severity: 'info', surface: 'example', message: 'a' },
            { code: 'z', severity: 'info', surface: 'example', message: 'z' },
          ],
    });

    const forward = output(false);
    const reorderedSets = output(true);
    (reorderedSets.theme as Record<string, unknown>).settings = (forward.theme as Record<string, unknown>).settings;
    const reorderedPalette = output(false);
    (reorderedPalette.theme as Record<string, unknown>).settings = (output(true).theme as Record<string, unknown>).settings;

    mockedOutput = forward;
    const first = await collect({ collector: 'wp-cli', wpPath: '/tmp/wp' });
    mockedOutput = reorderedSets;
    const second = await collect({ collector: 'wp-cli', wpPath: '/tmp/wp' });
    mockedOutput = reorderedPalette;
    const third = await collect({ collector: 'wp-cli', wpPath: '/tmp/wp' });

    expect(first.plugins?.map((plugin) => plugin.slug)).toEqual(['a/a.php', 'z/z.php']);
    expect(second.plugins?.map((plugin) => plugin.slug)).toEqual(['a/a.php', 'z/z.php']);
    expect(first.provenance.sourceHash).toBe(second.provenance.sourceHash);
    expect(first.provenance.sourceHash).not.toBe(third.provenance.sourceHash);
    expect(first.theme?.settings).toEqual({
      color: { palette: [{ slug: 'first', color: '#111' }, { slug: 'second', color: '#222' }] },
    });
    expect(third.theme?.settings).toEqual({
      color: { palette: [{ slug: 'second', color: '#222' }, { slug: 'first', color: '#111' }] },
    });
  });

  it('normalizes collector arrays with code-unit ordering', async () => {
    mockedOutput = {
      ...wpOutput(),
      blocks: {
        types: [
          { name: 'a', attributes: {}, supports: {}, source: 'plugin' },
          { name: 'Z', attributes: {}, supports: {}, source: 'plugin' },
          { name: '_internal', attributes: {}, supports: {}, source: 'plugin' },
        ],
      },
      bindings: {
        ...(wpOutput().bindings as Record<string, unknown>),
        supportedAttributes: {
          'core/a': ['a', 'Z', '_internal'],
          'core/Z': [],
          'core/_internal': [],
        },
      },
      contentModel: {
        postTypes: [
          {
            name: 'a',
            label: 'a',
            public: true,
            showInRest: true,
            taxonomies: ['a', 'Z', '_internal'],
            fields: [
              { name: 'date', source: 'core/post-data', args: { field: 'date' }, bindable: true },
              { name: 'link', source: 'core/post-data', args: { field: 'link' }, bindable: true },
            ],
          },
          { name: 'Z', label: 'Z', public: true, showInRest: true, taxonomies: [], fields: [] },
          { name: '_internal', label: '_internal', public: true, showInRest: true, taxonomies: [], fields: [] },
        ],
      },
    };

    const context = await collect({ collector: 'wp-cli', wpPath: '/tmp/wp' });

    expect(context.blocks?.types.map((block) => block.name)).toEqual(['Z', '_internal', 'a']);
    expect(Object.keys(context.bindings?.supportedAttributes ?? {})).toEqual(['core/Z', 'core/_internal', 'core/a']);
    expect(context.bindings?.supportedAttributes['core/a']).toEqual(['Z', '_internal', 'a']);
    expect(context.contentModel?.postTypes.map((postType) => postType.name)).toEqual(['Z', '_internal', 'a']);
    expect(context.contentModel?.postTypes[2]?.taxonomies).toEqual(['Z', '_internal', 'a']);
    expect(context.contentModel?.postTypes[2]?.fields.map((field) => field.name)).toEqual(['date', 'link']);
  });

  it('keeps collector post-data fields aligned with WordPress core bindings', () => {
    const source = collectorSourceForTests();

    expect(source).toContain("'name' => 'date', 'key' => 'date', 'source' => 'core/post-data'");
    expect(source).toContain("'args' => array('field' => 'date')");
    expect(source).toContain("'name' => 'modified', 'key' => 'modified', 'source' => 'core/post-data'");
    expect(source).toContain("'args' => array('field' => 'modified')");
    expect(source).toContain("'name' => 'link', 'key' => 'link', 'source' => 'core/post-data'");
    expect(source).toContain("'args' => array('field' => 'link')");
    expect(source).toContain("'source' => 'core/post-meta'");
    expect(source).toContain("'args' => array('key' => (string) $meta_key)");
    expect(source).not.toContain("array('key' => 'title', 'source' => 'core/post-data'");
    expect(source).not.toContain("array('key' => 'excerpt', 'source' => 'core/post-data'");
    expect(source).not.toContain("array('key' => 'featured_media', 'source' => 'core/post-data'");
  });

  it('keeps unavailable bindings free of supported-attribute fallback evidence', () => {
    const source = collectorSourceForTests();

    expect(source).toContain("if ($bindings_available) {");
    expect(source).toContain("$supported_attributes = wesper_json_map($supported_attributes);");
    expect(source).toContain("'bindings.unavailable'");
  });

  it('only warns about missing registered meta on public REST post types', () => {
    const source = collectorSourceForTests();

    expect(source).toContain(
      "if ((bool) $post_type_object->public && (bool) $post_type_object->show_in_rest && $rest_visible_meta_count === 0)",
    );
    expect(source).toContain('$rest_visible_meta_count++;');
  });
});

function wpOutput(): Record<string, unknown> {
  return {
    site: { url: 'https://example.test', name: 'Example', environment: 'local', isMultisite: false },
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
      settings: { color: { palette: [{ slug: 'primary', color: '#0057ff' }] } },
    },
    plugins: [],
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
          ],
        },
      ],
    },
    patterns: { items: [] },
    media: { imageSizes: [], maxUploadSize: 10485760 },
    warnings: [],
  };
}
