import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect, stringifyManifest } from '../index.js';

interface FetchStub {
  body: unknown;
  ok?: boolean;
  status?: number;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(routes: (url: string) => FetchStub | undefined): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => {
      const url = String(input);
      const route = routes(url);
      if (!route) {
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }
      return Promise.resolve(jsonResponse(route.body, route.ok ?? true, route.status ?? 200));
    }),
  );
}

function defaultRoutes(url: string): FetchStub | undefined {
  if (url.endsWith('/wp-json/')) {
    return { body: { name: 'Example', description: 'A site' } };
  }
  if (url.includes('/wp/v2/themes')) {
    return {
      body: [{ stylesheet: 'twentytwentyfive', template: 'twentytwentyfive', name: { rendered: 'Twenty Twenty-Five' }, version: '1.0', is_block_theme: true }],
    };
  }
  if (url.includes('/wp/v2/global-styles/themes/')) {
    return { body: { settings: { color: { palette: [{ slug: 'primary', color: '#0057ff' }] } } } };
  }
  if (url.includes('/wp/v2/block-types')) {
    return {
      body: [
        { name: 'core/paragraph', api_version: 3, title: 'Paragraph', category: 'text', attributes: {}, supports: {} },
        { name: 'acme/widget', api_version: 2, title: 'Widget', category: 'widgets', attributes: {}, supports: {} },
      ],
    };
  }
  if (url.includes('/wp/v2/types')) {
    return {
      body: {
        post: { name: 'Posts', viewable: true, taxonomies: ['category'] },
      },
    };
  }
  if (url.includes('/wp/v2/block-patterns/patterns')) {
    return {
      body: [
        { name: 'core/hero', title: 'Hero', categories: ['featured'], block_types: ['core/post-content'], post_types: [] },
      ],
    };
  }
  return undefined;
}

describe('REST collector', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('collects all core endpoints into a rest-provenanced manifest', async () => {
    stubFetch(defaultRoutes);

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test', wpUser: 'u', wpAppPassword: 'p' });

    expect(context.provenance.collector).toBe('rest');
    expect(context.theme?.tokens.colors).toEqual([{ slug: 'primary', value: '#0057ff' }]);
    expect(context.blocks?.types.map((block) => block.name)).toEqual(['acme/widget', 'core/paragraph']);
    expect(context.contentModel?.postTypes[0]?.fields.map((field) => field.name)).toEqual(['date', 'link', 'modified']);
    expect(context.contentModel?.postTypes[0]?.fields.every((field) => !field.bindable)).toBe(true);
    expect(context.patterns?.items.map((item) => item.name)).toEqual(['core/hero']);
    // Several REST surfaces are intentionally unavailable over core endpoints.
    // Their informational warnings still make the evidence partial.
    expect(context.provenance.partial).toBe(true);
  });

  it('rejects strict REST collection when binding evidence is unavailable', async () => {
    stubFetch(defaultRoutes);

    await expect(
      collect({ collector: 'rest', wpUrl: 'https://example.test', strict: true }),
    ).rejects.toMatchObject({
      code: 'WESPER_STRICT_POLICY',
      message: expect.stringContaining('bindings (unavailable)'),
    });
  });

  it('raises a transport error when no REST endpoint can be reached', async () => {
    stubFetch(() => undefined);

    await expect(collect({ collector: 'rest', wpUrl: 'https://example.test' })).rejects.toMatchObject({
      code: 'WESPER_TRANSPORT',
      message: expect.stringContaining('could not communicate'),
    });
  });

  it('stamps settingsOrigin as custom because REST returns the customization layer', async () => {
    stubFetch(defaultRoutes);

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test', wpUser: 'u', wpAppPassword: 'p' });

    expect(context.theme?.settingsOrigin).toBe('custom');
  });

  it('normalizes a wp-url that already includes the REST entry point', async () => {
    stubFetch(defaultRoutes);

    await collect({ collector: 'rest', wpUrl: 'https://example.test/wp-json/' });

    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.every(([url]) => !String(url).includes('/wp-json/wp-json'))).toBe(true);
  });

  it('authenticates and requests the edit context when credentials are supplied', async () => {
    stubFetch(defaultRoutes);

    await collect({ collector: 'rest', wpUrl: 'https://example.test', wpUser: 'u', wpAppPassword: 'p' });

    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const expectedAuth = `Basic ${Buffer.from('u:p').toString('base64')}`;
    const authedCall = calls.find(
      ([, init]) => ((init as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.Authorization,
    );
    expect((authedCall?.[1] as RequestInit).headers).toMatchObject({ Authorization: expectedAuth });
    const globalStylesCall = calls.find(([url]) => String(url).includes('/global-styles/themes/'));
    expect(String(globalStylesCall?.[0])).toContain('context=edit');
  });

  it('requests the view context when unauthenticated', async () => {
    stubFetch(defaultRoutes);

    await collect({ collector: 'rest', wpUrl: 'https://example.test' });

    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const globalStylesCall = calls.find(([url]) => String(url).includes('/global-styles/themes/'));
    expect(String(globalStylesCall?.[0])).toContain('context=view');
  });

  it('fails open per-slice when one endpoint fails', async () => {
    stubFetch((url) => {
      if (url.includes('/wp/v2/block-patterns/patterns')) {
        return { body: {}, ok: false, status: 403 };
      }
      return defaultRoutes(url);
    });

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test', wpUser: 'u', wpAppPassword: 'p' });

    expect(context.patterns).toBeUndefined();
    expect(context.warnings.map((warning) => warning.code)).toContain('patterns.rest_unavailable');
    expect(context.theme?.tokens.colors).toEqual([{ slug: 'primary', value: '#0057ff' }]);
    expect(context.blocks?.types.length).toBe(2);
  });

  it('warns but still returns a manifest when the REST root index is unreadable', async () => {
    stubFetch((url) => {
      if (url.endsWith('/wp-json/')) {
        return { body: {}, ok: false, status: 500 };
      }
      return defaultRoutes(url);
    });

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test', wpUser: 'u', wpAppPassword: 'p' });

    expect(context.warnings.map((warning) => warning.code)).toContain('site.rest_unavailable');
    expect(context.site.name).toBeUndefined();
    expect(context.blocks?.types.length).toBe(2);
  });

  it('requires a wp-url', async () => {
    await expect(collect({ collector: 'rest' })).rejects.toThrow('REST collector requires --wp-url.');
  });

  it('rejects URL userinfo before it can be requested or serialised', async () => {
    stubFetch(defaultRoutes);
    const password = 'synthetic-rest-app-password';

    await expect(
      collect({ collector: 'rest', wpUrl: `https://synthetic-user:${password}@example.test` }),
    ).rejects.toThrow('--wp-url must not contain URL credentials.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses to send an Application Password over a non-HTTPS connection', async () => {
    stubFetch(defaultRoutes);

    await expect(
      collect({ collector: 'rest', wpUrl: 'http://example.test', wpUser: 'u', wpAppPassword: 'p' }),
    ).rejects.toThrow('non-HTTPS connection');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows authenticated collection against localhost over http', async () => {
    stubFetch(defaultRoutes);

    const context = await collect({ collector: 'rest', wpUrl: 'http://localhost:8080', wpUser: 'u', wpAppPassword: 'p' });

    expect(context.provenance.collector).toBe('rest');
  });

  it('redacts secrets from collected settings', async () => {
    stubFetch((url) => {
      if (url.includes('/wp/v2/global-styles/themes/')) {
        return {
          body: {
            settings: {
              color: { palette: [{ slug: 'primary', color: '#0057ff' }] },
              custom: { apiKey: 'secret-value' },
            },
          },
        };
      }
      return defaultRoutes(url);
    });

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test', wpUser: 'u', wpAppPassword: 'p' });
    const serialized = stringifyManifest(context);

    expect(context.theme?.settings).toMatchObject({ custom: { apiKey: '[REDACTED]' } });
    expect(serialized).not.toContain('secret-value');
  });
});
