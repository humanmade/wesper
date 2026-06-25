import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectorSourceForTests } from './wpcli.js';
import { collect } from '../index.js';

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
    expect(context.bindings.supportedAttributes['core/paragraph']).toEqual(['content']);
    expect(context.theme.tokens.colors).toEqual([{ slug: 'primary', value: '#0057ff' }]);
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
