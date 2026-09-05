import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectorSourceForTests } from './wpcli.js';
import { collect, sourceHash, stringifyManifest, validate } from '../index.js';

let mockedOutput = wpOutput();

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file, _args, _options, callback) => {
    callback(null, { stdout: JSON.stringify(mockedOutput), stderr: '' });
  }),
}));

describe('WP-CLI collector', () => {
  afterEach(() => {
    mockedOutput = wpOutput();
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
    expect(context.theme?.tokens.colors).toEqual([{ slug: 'primary', value: '#0057ff' }]);
  });

  it('rejects actionable partial output in strict mode', async () => {
    mockedOutput = {
      ...wpOutput(),
      warnings: [
        {
          code: 'collector.partial',
          severity: 'warning',
          surface: 'bindings',
          message: 'Partial binding collection.',
        },
      ],
    };

    await expect(collect({ collector: 'wp-cli', wpPath: '/tmp/wp', strict: true })).rejects.toThrow(
      'Strict collection failed',
    );
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
        postTypes: [{ name: 'post', fields: [{ name: 'example', source: 'example/source', args: {} }] }],
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
        ? [{ slug: 'z/z.php', name: 'Zed' }, { slug: 'a/a.php', name: 'Aye' }]
        : [{ slug: 'a/a.php', name: 'Aye' }, { slug: 'z/z.php', name: 'Zed' }],
      blocks: {
        types: reverse
          ? [{ name: 'z/block', attributes: {}, supports: {} }, { name: 'a/block', attributes: {}, supports: {} }]
          : [{ name: 'a/block', attributes: {}, supports: {} }, { name: 'z/block', attributes: {}, supports: {} }],
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
                  { name: 'z', source: 'example/source', args: {} },
                  { name: 'a', source: 'example/source', args: {} },
                ]
              : [
                  { name: 'a', source: 'example/source', args: {} },
                  { name: 'z', source: 'example/source', args: {} },
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
              { name: 'a', source: 'core/post-data', args: { field: 'a' }, bindable: true },
              { name: 'Z', source: 'core/post-data', args: { field: 'Z' }, bindable: true },
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
    expect(context.contentModel?.postTypes[2]?.fields.map((field) => field.name)).toEqual(['Z', 'a']);
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
          ],
        },
      ],
    },
    patterns: { items: [] },
    media: { imageSizes: [], maxUploadSize: 10485760 },
    warnings: [],
  };
}
