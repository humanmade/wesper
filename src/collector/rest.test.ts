import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect, sourceHash, stringifyManifest } from '../index.js';

interface FetchStub {
  body: unknown;
  ok?: boolean;
  status?: number;
  response?: Partial<Response>;
}

function jsonResponse(body: unknown, ok = true, status = 200, response: Partial<Response> = {}): Response {
  return {
    ok,
    status,
    json: async () => body,
    ...response,
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
      return Promise.resolve(jsonResponse(route.body, route.ok ?? true, route.status ?? 200, route.response));
    }),
  );
}

function defaultRoutes(url: string): FetchStub | undefined {
  if (new URL(url).pathname === '/wp-json/') {
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

  it('does not project the slug-keyed post-type map', async () => {
    stubFetch(defaultRoutes);

    await collect({ collector: 'rest', wpUrl: 'https://example.test' });

    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const typesCall = calls.find(([url]) => String(url).includes('/wp/v2/types'));
    expect(String(typesCall?.[0])).not.toContain('_fields=');
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

  it('cancels an HTTP error body before failing its slice', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    stubFetch((url) => url.includes('/wp/v2/block-patterns/patterns')
      ? { body: {}, ok: false, status: 403, response: { body: { cancel } as unknown as ReadableStream<Uint8Array> } }
      : defaultRoutes(url));

    await collect({ collector: 'rest', wpUrl: 'https://example.test' });

    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a response declared larger than the configured limit', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
      const route = defaultRoutes(String(input));
      if (!route) return Promise.reject(new Error(`unexpected fetch: ${input}`));
      if (String(input).includes('/wp/v2/block-types')) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => '11' }, body: { cancel }, json: async () => route.body } as unknown as Response);
      }
      return Promise.resolve(jsonResponse(route.body, route.ok ?? true, route.status ?? 200));
    }));

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test', maxResponseBytes: 10 });

    expect(cancel).toHaveBeenCalledOnce();
    expect(context.warnings).toContainEqual(expect.objectContaining({ code: 'blocks.rest_unavailable', reason: 'response_too_large' }));
  });

  it('cancels a chunked response once its body exceeds the configured limit', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
      const route = defaultRoutes(String(input));
      if (!route) return Promise.reject(new Error(`unexpected fetch: ${input}`));
      if (String(input).includes('/wp/v2/block-types')) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('[{"name":'));
            controller.enqueue(new TextEncoder().encode('"core/paragraph"}]'));
          },
          cancel,
        });
        return Promise.resolve({ ok: true, status: 200, body: stream } as unknown as Response);
      }
      return Promise.resolve(jsonResponse(route.body, route.ok ?? true, route.status ?? 200));
    }));

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test', maxResponseBytes: 10 });

    expect(cancel).toHaveBeenCalledOnce();
    expect(context.warnings).toContainEqual(expect.objectContaining({ code: 'blocks.rest_unavailable', reason: 'response_too_large' }));
  });

  it('preserves a meaningful failure reason when every response exceeds the limit', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => '11' },
      body: { cancel },
    } as unknown as Response)));

    await expect(collect({ collector: 'rest', wpUrl: 'https://example.test', maxResponseBytes: 10 })).rejects.toMatchObject({
      code: 'WESPER_TRANSPORT',
      reason: 'response_too_large',
    });
    expect(cancel).toHaveBeenCalled();
  });

  it('honours pre-aborted collection signals without starting requests', async () => {
    stubFetch(defaultRoutes);
    const controller = new AbortController();
    controller.abort();

    await expect(collect({ collector: 'rest', wpUrl: 'https://example.test', signal: controller.signal })).rejects.toMatchObject({
      code: 'WESPER_TRANSPORT', reason: 'cancelled',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts in-flight REST requests when the caller cancels collection', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: string | URL, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })));
    const controller = new AbortController();
    const pending = collect({ collector: 'rest', wpUrl: 'https://example.test', signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'WESPER_TRANSPORT', reason: 'cancelled' });
    expect(fetch).toHaveBeenCalled();
  });

  it('aborts in-flight REST requests when the collection deadline expires', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: string | URL, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })));

    await expect(collect({ collector: 'rest', wpUrl: 'https://example.test', timeoutMs: 1 })).rejects.toMatchObject({
      code: 'WESPER_TRANSPORT', reason: 'deadline_exceeded',
    });
    expect(fetch).toHaveBeenCalled();
  });

  it('limits independent REST requests and keeps hashes deterministic', async () => {
    let active = 0;
    let peak = 0;
    vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
      const route = defaultRoutes(String(input));
      if (!route) return Promise.reject(new Error(`unexpected fetch: ${input}`));
      active += 1;
      peak = Math.max(peak, active);
      return Promise.resolve(jsonResponse(route.body, route.ok ?? true, route.status ?? 200)).finally(() => { active -= 1; });
    }));

    const first = await collect({ collector: 'rest', wpUrl: 'https://example.test', restConcurrency: 2 });
    const second = await collect({ collector: 'rest', wpUrl: 'https://example.test', restConcurrency: 2 });

    expect(peak).toBeLessThanOrEqual(2);
    expect(sourceHash(first)).toBe(sourceHash(second));
  });

  it('warns but still returns a manifest when the REST root index is unreadable', async () => {
    stubFetch((url) => {
      if (new URL(url).pathname === '/wp-json/') {
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
