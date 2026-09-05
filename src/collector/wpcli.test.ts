import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectorSourceForTests } from './wpcli.js';
import { normalizeCollectorOutput } from './normalize.js';
import { collect, stringifyManifest } from '../index.js';
import { coverageFor, strictCoverageGaps } from '../warnings.js';

let mockedOutput = wpOutput();

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file, _args, _options, callback) => {
    callback(null, { stdout: JSON.stringify(mockedOutput), stderr: '' });
  }),
}));

describe('WP-CLI collector', () => {
  afterEach(() => {
    mockedOutput = wpOutput();
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
    expect(context.provenance.partial).toBe(false);
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
