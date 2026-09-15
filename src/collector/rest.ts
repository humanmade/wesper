import { COLLECTOR_VERSION, normalizeCollectorOutput } from './normalize.js';
import { collectionControl, combineAbortSignals } from './control.js';
import { assertNoUrlCredentials } from './safe.js';
import { siteContextSchema } from '../schema.js';
import { CONTEXT_VERSION, SCHEMA_URL, CollectionTransportError, UsageError, type CollectionFailureReason, type CollectOptions, type ContextWarning, type SiteContext } from '../types.js';

const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CORE_POST_DATA_FIELDS = [
  { name: 'date', key: 'date', source: 'core/post-data', args: { field: 'date' }, type: 'string', bindable: false },
  { name: 'modified', key: 'modified', source: 'core/post-data', args: { field: 'modified' }, type: 'string', bindable: false },
  { name: 'link', key: 'link', source: 'core/post-data', args: { field: 'link' }, type: 'string', bindable: false },
];
type JsonResult = { value: unknown; bytes: number };
type Slice = { surface: string; run(): Promise<Record<string, unknown>> };
type RestRoot = { site: string; endpoint(path: string, fields?: string, extra?: Record<string, string>): string; fallback(path: string, fields?: string, extra?: Record<string, string>): string | undefined };

export async function collectRest(options: CollectOptions): Promise<SiteContext> {
  if (!options.wpUrl) throw new UsageError('REST collector requires --wp-url.');
  assertNoUrlCredentials(options.wpUrl, '--wp-url');
  const root = siteRoot(options.wpUrl);
  const auth = authorization(options);
  if (auth) requireSecureTransport(root.site);
  const concurrency = positiveOption(options.restConcurrency, DEFAULT_CONCURRENCY, '--rest-concurrency');
  const maxResponseBytes = positiveOption(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, '--max-response-bytes');
  const control = collectionControl(options);
  const warnings: ContextWarning[] = [];
  const raw: Record<string, unknown> = { warnings };
  let requestAttempts = 0;
  let responseBytes = 0;
  const startedAt = performance.now();
  const readJson = async (path: string, fields?: string, extra?: Record<string, string>): Promise<unknown> => {
    control.throwIfAborted();
    const response = await getJson(root.endpoint(path, fields, extra), root.fallback(path, fields, extra), auth, control.signal, maxResponseBytes, () => { requestAttempts += 1; });
    control.throwIfAborted();
    responseBytes += response.bytes;
    return response.value;
  };
  const slices: Slice[] = [
    { surface: 'site', async run() {
      const index = record(await readJson('', 'name'));
      if (!index) throw malformed();
      return validatedSlice({ site: { url: root.site, ...(typeof index.name === 'string' ? { name: index.name } : {}), environment: 'unknown', isMultisite: false } });
    } },
    { surface: 'theme', async run() {
      const themes = await readJson('wp/v2/themes', 'stylesheet,template,name,version,is_block_theme', { status: 'active' }) as Array<Record<string, unknown>>;
      const theme = Array.isArray(themes) ? themes[0] : undefined;
      if (!theme || !record(theme)) throw malformed();
      const metadata = themeMetadata(theme);
      validatedSlice({ theme: metadata });
      if (!hasOwn(theme, 'stylesheet')) return validatedSlice({ theme: metadata });
      if (typeof theme.stylesheet !== 'string') throw malformed();
      try {
        const styleRecord = record(await readJson(`wp/v2/global-styles/themes/${encodeURIComponent(theme.stylesheet)}`, 'settings', { context: auth ? 'edit' : 'view' }));
        if (!styleRecord || !hasOwn(styleRecord, 'settings') || styleRecord.settings === null) throw malformed();
        return validatedSlice({ theme: { ...metadata, settings: styleRecord.settings } });
      } catch (error) {
        // The active-theme endpoint remains useful evidence if its dependent
        // customization request is unavailable. Preserve it with a scoped gap.
        warnings.push(sliceWarning('theme.settings', error));
        return validatedSlice({ theme: metadata });
      }
    } },
    { surface: 'blocks', async run() {
      const blockResponse = await readJson('wp/v2/block-types', 'name,api_version,title,category,attributes,supports,parent,ancestor,allowed_blocks,uses_context,provides_context,styles,is_dynamic,editor_script_handles,script_handles,view_script_handles,view_script_module_ids,editor_style_handles,style_handles,view_style_handles');
      if (!Array.isArray(blockResponse)) throw malformed();
      const blocks = blockResponse.map(record);
      if (blocks.some((block) => !block || typeof block.name !== 'string')) throw malformed();
      const blockRecords = blocks as Array<Record<string, unknown>>;
      const missingRequiredEvidence = blockRecords.some((block) => !hasOwn(block, 'attributes') || !hasOwn(block, 'supports'));
      if (missingRequiredEvidence) warnings.push({ code: 'blocks.rest_legacy_metadata_unavailable', severity: 'info', surface: 'blocks', message: 'One or more REST block records omitted legacy attributes or supports metadata; schema defaults were used.', coverage: 'partial' });
      return validatedSlice({ blocks: { types: blockRecords.map((block) => ({
        name: block.name,
        ...(hasOwn(block, 'api_version') ? { apiVersion: block.api_version } : {}),
        ...(hasOwn(block, 'title') ? { title: block.title } : {}),
        ...(hasOwn(block, 'category') ? { category: block.category } : {}),
        ...(hasOwn(block, 'attributes') ? { attributes: emptyArrayMap(block.attributes) } : { attributes: {} }),
        ...(hasOwn(block, 'supports') ? { supports: emptyArrayMap(block.supports) } : { supports: {} }),
        source: String(block.name).startsWith('core/') ? 'core' : 'plugin',
        ...(hasOwn(block, 'parent') ? { parent: block.parent ?? null } : {}),
        ...(hasOwn(block, 'ancestor') ? { ancestor: block.ancestor ?? null } : {}),
        ...(hasOwn(block, 'allowed_blocks') ? { allowedBlocks: block.allowed_blocks ?? null } : {}),
        ...(hasOwn(block, 'uses_context') ? { usesContext: block.uses_context } : {}),
        ...(hasOwn(block, 'provides_context') ? { providesContext: emptyArrayMap(block.provides_context) } : {}),
        ...(hasOwn(block, 'styles') ? { styles: Array.isArray(block.styles) ? block.styles.map((style) => {
          const value = record(style) ?? {};
          return { name: value.name, ...(hasOwn(value, 'label') ? { label: value.label } : {}), ...(hasOwn(value, 'is_default') ? { isDefault: value.is_default } : {}) };
        }) : block.styles } : {}),
        ...(assetEvidence(block)),
        ...(hasOwn(block, 'is_dynamic') ? { render: { isDynamic: block.is_dynamic } } : {}),
      })) } });
    } },
    { surface: 'contentModel', async run() {
      let types: unknown;
      try { types = await readJson('wp/v2/types', undefined, auth ? { context: 'edit' } : {}); }
      catch (error) {
        if (!auth || !isAuthFailure(error)) throw error;
        warnings.push({ code: 'contentModel.rest_edit_context_unavailable', severity: 'warning', surface: 'contentModel', reason: error.reason, message: 'Authenticated REST post-type edit context was unavailable; retried the public view context, which omits public-status evidence.', coverage: 'partial' });
        types = await readJson('wp/v2/types');
      }
      const typeMap = record(types); if (!typeMap) throw malformed();
      return validatedSlice({ contentModel: { postTypes: Object.entries(typeMap).map(([name, value]) => { const type = record(value); if (!type) throw malformed(); return { name, ...(hasOwn(type, 'name') ? { label: type.name } : {}), showInRest: true, ...(hasOwn(type, 'hierarchical') ? { hierarchical: type.hierarchical } : {}), ...(hasOwn(type, 'supports') ? { supports: emptyArrayMap(type.supports) } : {}), ...(hasOwn(type, 'taxonomies') ? { taxonomies: type.taxonomies } : {}), fields: CORE_POST_DATA_FIELDS.map((field) => ({ ...field, args: { ...field.args } })) }; }) } });
    } },
    { surface: 'patterns', async run() {
      const patterns = await readJson('wp/v2/block-patterns/patterns', 'name,title,categories,block_types,post_types') as Array<Record<string, unknown>>;
      if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern.name !== 'string')) throw malformed();
      return validatedSlice({ patterns: { items: patterns.map((pattern) => ({ name: pattern.name, title: pattern.title ?? null, categories: pattern.categories ?? [], blockTypes: pattern.block_types ?? [], postTypes: pattern.post_types ?? [] })) } });
    } },
  ];
  try {
    const outcomes = await boundedAll(slices, concurrency);
    control.throwIfAborted();
    for (const [index, result] of outcomes.entries()) { const slice = slices[index]!; if (result.status === 'fulfilled') Object.assign(raw, result.value); else warnings.push(sliceWarning(slice.surface, result.reason)); }
    if (!('site' in raw)) raw.site = { url: root.site, environment: 'unknown', isMultisite: false };
    if ('theme' in raw) warnings.push({ code: 'theme.rest_theme_layer', severity: 'info', surface: 'theme.settings', message: 'REST global-styles returns the core, block, and theme layer; user customizations are not included. Use WP-CLI collection for merged effective settings.', coverage: 'partial' });
    if ('contentModel' in raw) warnings.push({ code: 'content_model.rest_meta_unavailable', severity: 'info', surface: 'contentModel', message: 'Registered post meta is not enumerable over the core REST API; only core post-data fields are reported.', coverage: 'partial' });
    warnings.push(
      { code: 'wordpress.rest_unavailable', severity: 'info', surface: 'wordpress', message: 'WordPress version/features are not exposed over the core REST API.', coverage: 'unavailable' },
      { code: 'bindings.rest_unavailable', severity: 'info', surface: 'bindings', message: 'Block binding sources are not exposed over the core REST API.', coverage: 'unavailable' },
      { code: 'plugins.rest_unavailable', severity: 'info', surface: 'plugins', message: 'Plugins are not retrievable over REST without elevated capabilities.', coverage: 'unavailable' },
      { code: 'media.rest_unavailable', severity: 'info', surface: 'media', message: 'Registered image sizes are not exposed over core REST API.', coverage: 'unavailable' },
      { code: 'site.isMultisite.rest_unavailable', severity: 'info', surface: 'site.isMultisite', message: 'Multisite status is not exposed over the core REST API; the V1 false default is retained.', coverage: 'unavailable' },
    );
    if (!outcomes.some((result) => result.status === 'fulfilled')) {
      const failure = outcomes.find((result) => result.status === 'rejected');
      const reason = failure?.status === 'rejected' && failure.reason instanceof CollectionTransportError
        ? failure.reason.reason ?? 'transport_failed'
        : 'transport_failed';
      throw new CollectionTransportError('REST collector could not communicate with any REST endpoint.', reason);
    }
    raw.provenance = { collectionMetrics: { latencyMs: Math.round(performance.now() - startedAt), responseBytes, requests: requestAttempts } };
    return normalizeCollectorOutput(raw, { collector: 'rest', collectorVersion: COLLECTOR_VERSION });
  } finally { control.dispose(); }
}

async function boundedAll<T>(slices: Slice[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(slices.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, slices.length) }, async () => { while (next < slices.length) { const index = next++; try { results[index] = { status: 'fulfilled', value: await slices[index]!.run() as T }; } catch (reason) { results[index] = { status: 'rejected', reason }; } } }));
  return results;
}
async function getJson(url: string, fallbackUrl: string | undefined, auth: string, collectionSignal: AbortSignal, maxBytes: number, onAttempt: () => void): Promise<JsonResult> {
  try { return await requestJson(url, auth, collectionSignal, maxBytes, onAttempt); }
  catch (error) { if (fallbackUrl && error instanceof CollectionTransportError && (error.reason === 'route_unavailable' || error.reason === 'malformed_response')) return requestJson(fallbackUrl, auth, collectionSignal, maxBytes, onAttempt); throw error; }
}
async function requestJson(url: string, auth: string, collectionSignal: AbortSignal, maxBytes: number, onAttempt: () => void): Promise<JsonResult> {
  const request = new AbortController(); const timer = setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS); const combined = combineAbortSignals([collectionSignal, request.signal]);
  try {
    onAttempt();
    const response = await fetch(url, { headers: auth ? { Authorization: auth } : {}, signal: combined.signal });
    if (!response.ok) { await discard(response); throw httpFailure(response.status); }
    const length = Number(response.headers?.get?.('content-length')); if (Number.isFinite(length) && length > maxBytes) { await discard(response); throw tooLarge(); }
    const text = await boundedText(response, maxBytes); try { return { value: JSON.parse(text), bytes: Buffer.byteLength(text) }; } catch { throw malformed(); }
  } catch (error) {
    if (error instanceof CollectionTransportError) throw error;
    if (collectionSignal.aborted) throw new CollectionTransportError('Collection was cancelled.', 'cancelled');
    if (request.signal.aborted) throw new CollectionTransportError('REST request timed out.', 'timeout');
    throw new CollectionTransportError('REST request failed.', 'transport_failed');
  } finally { clearTimeout(timer); combined.dispose(); }
}
async function discard(response: Response): Promise<void> { try { await response.body?.cancel(); } catch { /* cancellation is best effort */ } }
async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) { const text = await response.text(); if (Buffer.byteLength(text) > maxBytes) throw tooLarge(); return text; }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength; if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw tooLarge(); } chunks.push(part.value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return new TextDecoder().decode(bytes);
}
function sliceWarning(surface: string, error: unknown): ContextWarning { const reason = error instanceof CollectionTransportError ? error.reason ?? 'transport_failed' : 'transport_failed'; const labels: Record<string, string> = { route_unavailable: 'unavailable route', authentication_failed: 'authentication failure', permission_denied: 'permission denied', timeout: 'timeout', response_too_large: 'oversized response', malformed_response: 'malformed response', cancelled: 'cancellation', deadline_exceeded: 'deadline exceeded', transport_failed: 'transport failure' }; return { code: `${surface}.rest_unavailable`, severity: 'warning', surface, reason, message: `REST ${surface} evidence could not be retrieved (${labels[reason] ?? 'transport failure'}).`, coverage: 'unavailable' }; }
function httpFailure(status: number): CollectionTransportError { const reason: CollectionFailureReason = status === 401 ? 'authentication_failed' : status === 403 ? 'permission_denied' : status === 404 ? 'route_unavailable' : 'transport_failed'; return new CollectionTransportError('REST request was rejected.', reason); }
function malformed(): CollectionTransportError { return new CollectionTransportError('REST response was malformed.', 'malformed_response'); }
function tooLarge(): CollectionTransportError { return new CollectionTransportError('REST response exceeded the configured size limit.', 'response_too_large'); }
function positiveOption(value: number | undefined, fallback: number, flag: string): number { const chosen = value ?? fallback; if (!Number.isSafeInteger(chosen) || chosen <= 0) throw new UsageError(`${flag} must be a positive integer.`); return chosen; }
function authorization(options: CollectOptions): string { const user = options.wpUser ?? ''; const password = options.wpAppPassword ?? ''; if (Boolean(user) !== Boolean(password)) throw new UsageError('REST collector requires both --wp-user and an Application Password, or neither.'); return user ? `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` : ''; }
function siteRoot(wpUrl: string): RestRoot {
  try {
    const supplied = new URL(wpUrl);
    if (supplied.protocol !== 'http:' && supplied.protocol !== 'https:') throw new Error();
    const explicitRoute = supplied.searchParams.get('rest_route');
    supplied.search = ''; supplied.hash = '';
    const api = new URL(supplied);
    if (/\/wp-json\/?$/.test(api.pathname)) api.pathname = api.pathname.replace(/\/wp-json\/?$/, '/');
    if (!api.pathname.endsWith('/')) api.pathname += '/';
    const site = api.toString().replace(/\/$/, '');
    const pretty = (path: string, fields?: string, extra: Record<string, string> = {}): string => endpointUrl(new URL('wp-json/', api), path, fields, extra, false);
    const query = (path: string, fields?: string, extra: Record<string, string> = {}): string => endpointUrl(api, path, fields, extra, true);
    return explicitRoute !== null
      ? { site, endpoint: query, fallback: () => undefined }
      : { site, endpoint: pretty, fallback: query };
  } catch { throw new UsageError('REST collector requires a valid absolute --wp-url.'); }
}
function endpointUrl(base: URL, path: string, fields: string | undefined, extra: Record<string, string>, queryRoute: boolean): string {
  const url = new URL(base);
  if (queryRoute) url.searchParams.set('rest_route', `/${path}`);
  else url.pathname += path;
  if (fields) url.searchParams.set('_fields', fields);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url.toString();
}
function requireSecureTransport(wpUrl: string): void { const url = new URL(wpUrl); const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'; if (url.protocol !== 'https:' && !local) throw new UsageError('REST collector refuses to send an Application Password over a non-HTTPS connection. Use an https:// URL (localhost excepted).'); }
function themeMetadata(theme: Record<string, unknown>): Record<string, unknown> {
  if (hasOwn(theme, 'name') && typeof theme.name !== 'string' && (!record(theme.name) || (hasOwn(record(theme.name)!, 'rendered') && typeof record(theme.name)!.rendered !== 'string'))) throw malformed();
  return {
    ...(hasOwn(theme, 'stylesheet') ? { stylesheet: theme.stylesheet } : {}),
    ...(hasOwn(theme, 'template') ? { template: theme.template } : {}),
    ...(hasOwn(theme, 'name') ? { name: themeName(theme.name) } : {}),
    ...(hasOwn(theme, 'version') ? { version: theme.version } : {}),
    ...(hasOwn(theme, 'is_block_theme') ? { isBlockTheme: theme.is_block_theme } : {}),
  };
}
function themeName(name: unknown): string | undefined { return typeof name === 'string' ? name : record(name)?.rendered as string | undefined; }
function record(value: unknown): Record<string, any> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined; }
function hasOwn(value: Record<string, unknown>, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function emptyArrayMap(value: unknown): unknown { return Array.isArray(value) && value.length === 0 ? {} : value; }
function isAuthFailure(error: unknown): error is CollectionTransportError { return error instanceof CollectionTransportError && (error.reason === 'authentication_failed' || error.reason === 'permission_denied'); }
function assetEvidence(block: Record<string, unknown>): Record<string, unknown> {
  const fields: Array<[string, string]> = [
    ['editor_script_handles', 'editorScripts'], ['script_handles', 'scripts'], ['view_script_handles', 'viewScripts'], ['view_script_module_ids', 'viewScriptModules'], ['editor_style_handles', 'editorStyles'], ['style_handles', 'styles'], ['view_style_handles', 'viewStyles'],
  ];
  const assets: Record<string, unknown> = {};
  for (const [source, target] of fields) if (hasOwn(block, source)) assets[target] = block[source];
  return Object.keys(assets).length > 0 ? { assets } : {};
}
function validatedSlice(value: Record<string, unknown>): Record<string, unknown> {
  const result = siteContextSchema.safeParse({
    $schema: SCHEMA_URL,
    contextVersion: CONTEXT_VERSION,
    site: {},
    provenance: { collectedAt: new Date(0).toISOString(), collector: 'rest', collectorVersion: COLLECTOR_VERSION, sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000', partial: false },
    warnings: [],
    ...value,
  });
  if (!result.success) throw malformed();
  return value;
}
