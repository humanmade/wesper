import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
          fields: [{ key: 'title', source: 'core/post-data', type: 'string', bindable: true }],
        },
      ],
    },
    patterns: { items: [] },
    media: { imageSizes: [], maxUploadSize: 10485760 },
    warnings: [],
  };
}
