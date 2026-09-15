import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect, sourceHash, stringifyManifest } from '../index.js';
import { COLLECTOR_VERSION } from './normalize.js';

interface FetchStub {
  body: unknown;
  ok?: boolean;
  status?: number;
  response?: Partial<Response>;
}

function jsonResponse(body: unknown, ok = true, status = 200, response: Partial<Response> = {}): Response {
  const actual = realResponse(JSON.stringify(body), ok ? status : status >= 400 ? status : 500, { 'content-type': 'application/json' });
  return {
    ok: actual.ok,
    status: actual.status,
    headers: actual.headers,
    body: actual.body,
    text: () => actual.text(),
    ...response,
  } as unknown as Response;
}

function realResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
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
  const parsed = new URL(url);
  const path = parsed.searchParams.get('rest_route') ?? parsed.pathname;
  if (path === '/' || path.endsWith('/wp-json/')) {
    return { body: { name: 'Example', description: 'A site' } };
  }
  if (path.includes('/wp/v2/themes')) {
    return {
      body: [{ stylesheet: 'twentytwentyfive', template: 'twentytwentyfive', name: { rendered: 'Twenty Twenty-Five' }, version: '1.0', is_block_theme: true }],
    };
  }
  if (path.includes('/wp/v2/global-styles/themes/')) {
    return { body: { settings: { color: { palette: [{ slug: 'primary', color: '#0057ff' }] } } } };
  }
  if (path.includes('/wp/v2/block-types')) {
    return {
      body: [
        {
          name: 'core/paragraph', api_version: 3, title: 'Paragraph', category: 'text', attributes: {}, supports: {},
          parent: null, ancestor: null, allowed_blocks: ['core/group'], uses_context: ['postId'],
          provides_context: { 'core/postId': 'postId' },
          styles: [{ name: 'plain', label: 'Plain', is_default: true }], is_dynamic: true,
          editor_script_handles: ['wp-block-editor'], script_handles: [], view_script_handles: ['paragraph-view'],
          view_script_module_ids: ['paragraph/module'], editor_style_handles: [], style_handles: ['wp-block-paragraph'], view_style_handles: ['wp-block-paragraph-view'],
        },
        { name: 'acme/widget', api_version: 2, title: 'Widget', category: 'widgets', attributes: {}, supports: {} },
      ],
    };
  }
  if (path.includes('/wp/v2/types')) {
    return {
      body: {
        post: { name: 'Posts', viewable: true, hierarchical: false, supports: { title: true, editor: true }, taxonomies: ['category'] },
      },
    };
  }
  if (path.includes('/wp/v2/block-patterns/patterns')) {
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
    expect(context.provenance.collectorVersion).toBe(COLLECTOR_VERSION);
    expect(context.theme?.tokens?.colors[0]).toMatchObject({
      id: 'color:primary', kind: 'color', slug: 'primary', value: '#0057ff', origin: 'unknown',
      references: { cssCustomProperty: '--wp--preset--color--primary', cssValue: 'var(--wp--preset--color--primary)', blockStyle: 'var:preset|color|primary' },
    });
    expect(context.blocks?.types.map((block) => block.name)).toEqual(['acme/widget', 'core/paragraph']);
    expect(context.blocks?.types[1]).toMatchObject({
      allowedBlocks: ['core/group'],
      usesContext: ['postId'],
      providesContext: { 'core/postId': 'postId' },
      styles: [{ name: 'plain', label: 'Plain', isDefault: true }],
      assets: { viewScripts: ['paragraph-view'], viewScriptModules: ['paragraph/module'], viewStyles: ['wp-block-paragraph-view'] },
      render: { isDynamic: true },
    });
    expect(context.contentModel?.postTypes[0]).toMatchObject({
      hierarchical: false,
      supports: { title: true, editor: true },
    });
    expect(context.contentModel?.postTypes[0]?.fields.map((field) => field.name)).toEqual(['date', 'link', 'modified']);
    expect(context.contentModel?.postTypes[0]?.fields.every((field) => !field.bindable)).toBe(true);
    expect(context.patterns?.items.map((item) => item.name)).toEqual(['core/hero']);
    // Several REST surfaces are intentionally unavailable over core endpoints.
    // Their informational warnings still make the evidence partial.
    expect(context.provenance.partial).toBe(true);
    expect(JSON.stringify(context.warnings)).not.toContain('get-site-context');
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

  it('stamps settingsOrigin as theme because REST returns the core, block, and theme layer', async () => {
    stubFetch(defaultRoutes);

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test', wpUser: 'u', wpAppPassword: 'p' });

    expect(context.theme?.settingsOrigin).toBe('theme');
  });

  it('publishes bounded collection metrics through the manifest contract', async () => {
    stubFetch(defaultRoutes);

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test' });

    expect(context.provenance.collectionMetrics).toMatchObject({
      latencyMs: expect.any(Number),
      responseBytes: expect.any(Number),
      requests: 6,
    });
    expect(context.provenance.collectionMetrics?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(context.provenance.collectionMetrics?.responseBytes).toBeGreaterThan(0);
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

  it('uses authenticated post-type edit context and never infers public from viewable', async () => {
    stubFetch(defaultRoutes);

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test', wpUser: 'u', wpAppPassword: 'p' });

    expect(context.contentModel?.postTypes[0]?.public).toBeUndefined();
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const typesCall = calls.find(([url]) => String(url).includes('/wp/v2/types'));
    expect(String(typesCall?.[0])).toContain('context=edit');
  });

  it('retries authenticated post types in view context after an edit-context denial', async () => {
    let editAttempts = 0;
    stubFetch((url) => {
      if (url.includes('/wp/v2/types') && new URL(url).searchParams.get('context') === 'edit') {
        editAttempts += 1;
        return { body: {}, ok: false, status: 403 };
      }
      return defaultRoutes(url);
    });

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test', wpUser: 'u', wpAppPassword: 'p' });

    expect(editAttempts).toBe(1);
    expect(context.contentModel?.postTypes[0]).toMatchObject({ name: 'post', showInRest: true });
    expect(context.contentModel?.postTypes[0]?.public).toBeUndefined();
    expect(context.warnings).toContainEqual(expect.objectContaining({ code: 'contentModel.rest_edit_context_unavailable', coverage: 'partial' }));
  });

  it('omits unknown optional block and post-type metadata without fabricating empty evidence', async () => {
    stubFetch((url) => {
      if (url.includes('/wp/v2/block-types')) return { body: [{ name: 'core/paragraph', attributes: {}, supports: {} }] };
      if (url.includes('/wp/v2/types')) return { body: { post: { name: 'Posts' } } };
      return defaultRoutes(url);
    });

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test' });
    const block = context.blocks?.types[0];
    const postType = context.contentModel?.postTypes[0];

    expect(block).toMatchObject({ name: 'core/paragraph', attributes: {}, supports: {} });
    expect(block?.styles).toBeUndefined();
    expect(block?.assets).toBeUndefined();
    expect(block?.render).toBeUndefined();
    expect(postType?.hierarchical).toBeUndefined();
    expect(postType?.supports).toBeUndefined();
    expect(postType?.taxonomies).toEqual([]); // schema materializes only its documented default.
  });

  it('accepts WordPress empty-array transport values at known dictionary boundaries', async () => {
    stubFetch((url) => {
      if (url.includes('/wp/v2/block-types')) return { body: [{ name: 'core/paragraph', attributes: [], supports: [], provides_context: [] }] };
      if (url.includes('/wp/v2/types')) return { body: { post: { name: 'Posts', supports: [] } } };
      return defaultRoutes(url);
    });

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test' });

    expect(context.blocks?.types[0]).toMatchObject({ attributes: {}, supports: {}, providesContext: {} });
    expect(context.contentModel?.postTypes[0]?.supports).toEqual({});
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
    expect(context.theme?.tokens?.colors[0]).toMatchObject({ id: 'color:primary', value: '#0057ff' });
    expect(context.blocks?.types.length).toBe(2);
  });

  it('retains active-theme metadata when its dependent settings request fails', async () => {
    stubFetch((url) => url.includes('/wp/v2/global-styles/themes/')
      ? { body: {}, ok: false, status: 403 }
      : defaultRoutes(url));

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test', wpUser: 'u', wpAppPassword: 'p' });

    expect(context.theme).toMatchObject({ stylesheet: 'twentytwentyfive', name: 'Twenty Twenty-Five' });
    expect(context.theme?.settings).toBeUndefined();
    expect(context.warnings).toContainEqual(expect.objectContaining({
      code: 'theme.settings.rest_unavailable', reason: 'permission_denied', coverage: 'unavailable',
    }));
  });

  it('classifies a null site index as malformed evidence', async () => {
    stubFetch((url) => new URL(url).pathname === '/wp-json/' ? { body: null } : defaultRoutes(url));

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test' });

    expect(context.warnings).toContainEqual(expect.objectContaining({
      code: 'site.rest_unavailable', reason: 'malformed_response',
    }));
  });

  it.each([
    { blocks: [{ name: 'core/paragraph', attributes: 42, supports: {} }] },
    { blocks: [{ name: 'core/paragraph', attributes: {}, supports: {} }, { name: 'core/paragraph', attributes: {}, supports: {} }] },
  ])('discards only malformed block evidence', async ({ blocks }) => {
    stubFetch((url) => url.includes('/wp/v2/block-types') ? { body: blocks } : defaultRoutes(url));

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test' });

    expect(context.blocks).toBeUndefined();
    expect(context.theme?.stylesheet).toBe('twentytwentyfive');
    expect(context.warnings).toContainEqual(expect.objectContaining({ code: 'blocks.rest_unavailable', reason: 'malformed_response' }));
  });

  it('discards blocks when present optional style evidence is malformed', async () => {
    stubFetch((url) => url.includes('/wp/v2/block-types')
      ? { body: [{ name: 'core/paragraph', attributes: {}, supports: {}, styles: 42 }] }
      : defaultRoutes(url));

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test' });

    expect(context.blocks).toBeUndefined();
    expect(context.warnings).toContainEqual(expect.objectContaining({ code: 'blocks.rest_unavailable', reason: 'malformed_response' }));
  });

  it('discards content-model evidence when one mapped type record is malformed', async () => {
    stubFetch((url) => url.includes('/wp/v2/types') ? { body: { post: null } } : defaultRoutes(url));

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test' });

    expect(context.contentModel).toBeUndefined();
    expect(context.warnings).toContainEqual(expect.objectContaining({ code: 'contentModel.rest_unavailable', reason: 'malformed_response' }));
  });

  it('rejects a collection where every successful endpoint returned JSON null', async () => {
    stubFetch(() => ({ body: null }));

    await expect(collect({ collector: 'rest', wpUrl: 'https://example.test' })).rejects.toMatchObject({
      code: 'WESPER_TRANSPORT', reason: 'malformed_response',
    });
  });

  it('rejects non-null primitive responses when no slice can validate them', async () => {
    stubFetch(() => ({ body: 42 }));

    await expect(collect({ collector: 'rest', wpUrl: 'https://example.test' })).rejects.toMatchObject({
      code: 'WESPER_TRANSPORT', reason: 'malformed_response',
    });
  });

  it.each([null, []])('classifies an empty active-theme response %j as malformed evidence', async (body) => {
    stubFetch((url) => url.includes('/wp/v2/themes') ? { body } : defaultRoutes(url));

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test' });

    expect(context.theme).toBeUndefined();
    expect(context.warnings).toContainEqual(expect.objectContaining({
      code: 'theme.rest_unavailable', reason: 'malformed_response',
    }));
  });

  it.each([null, {}])('classifies an empty theme-settings response %j while retaining theme metadata', async (body) => {
    stubFetch((url) => url.includes('/wp/v2/global-styles/themes/') ? { body } : defaultRoutes(url));

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test' });

    expect(context.theme?.stylesheet).toBe('twentytwentyfive');
    expect(context.warnings).toContainEqual(expect.objectContaining({
      code: 'theme.settings.rest_unavailable', reason: 'malformed_response',
    }));
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
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => '501' }, body: { cancel } } as unknown as Response);
      }
      return Promise.resolve(jsonResponse(route.body, route.ok ?? true, route.status ?? 200));
    }));

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test', maxResponseBytes: 500 });

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
            controller.enqueue(new TextEncoder().encode('['));
            controller.enqueue(new TextEncoder().encode(`"${'x'.repeat(500)}"]`));
          },
          cancel,
        });
        return Promise.resolve({ ok: true, status: 200, body: stream } as unknown as Response);
      }
      return Promise.resolve(jsonResponse(route.body, route.ok ?? true, route.status ?? 200));
    }));

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test', maxResponseBytes: 500 });

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

  it('allows authenticated HTTP collection against IPv6 loopback', async () => {
    stubFetch(defaultRoutes);

    const context = await collect({ collector: 'rest', wpUrl: 'http://[::1]:8080', wpUser: 'u', wpAppPassword: 'p' });

    expect(context.provenance.collector).toBe('rest');
  });

  it.each([
    ['https://example.test/wp-json/', 'https://example.test'],
    ['https://example.test/subdir/#ignored', 'https://example.test/subdir'],
    ['https://example.test/?rest_route=/', 'https://example.test'],
  ])('accepts REST URL forms and records a query-free site provenance URL', async (wpUrl, expectedSite) => {
    stubFetch(defaultRoutes);

    const context = await collect({ collector: 'rest', wpUrl });

    expect(context.site.url).toBe(expectedSite);
  });

  it('falls back to same-origin rest_route requests after a pretty permalink 404', async () => {
    let prettyRequests = 0;
    let routeFallbacks = 0;
    stubFetch((url) => {
      const parsed = new URL(url);
      if (parsed.searchParams.has('rest_route')) { routeFallbacks += 1; return defaultRoutes(`https://example.test/wp-json/${parsed.searchParams.get('rest_route')?.replace(/^\//, '')}`); }
      if (parsed.pathname.includes('/wp-json/')) { prettyRequests += 1; return { body: {}, ok: false, status: 404 }; }
      return defaultRoutes(url);
    });

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test/subdir' });

    expect(prettyRequests).toBe(6);
    expect(routeFallbacks).toBe(6);
    expect(context.blocks?.types).toHaveLength(2);
    expect(context.provenance.collectionMetrics?.requests).toBe(12);
  });

  it('falls back to same-origin rest_route requests when a plain permalink returns HTML', async () => {
    let routeFallbacks = 0;
    vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
      const parsed = new URL(String(input));
      if (parsed.searchParams.has('rest_route')) {
        routeFallbacks += 1;
        return Promise.resolve(jsonResponse(defaultRoutes(`https://example.test/wp-json/${parsed.searchParams.get('rest_route')?.replace(/^\//, '')}`)?.body));
      }
      return Promise.resolve(realResponse('<html><body>front page</body></html>', 200, { 'content-type': 'text/html' }));
    }));

    const context = await collect({ collector: 'rest', wpUrl: 'https://example.test/subdir' });

    expect(routeFallbacks).toBe(6);
    expect(context.blocks?.types).toHaveLength(2);
    expect(context.provenance.collectionMetrics?.requests).toBe(12);
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
