import { COLLECTOR_VERSION, normalizeCollectorOutput } from './normalize.js';
import { collectionControl } from './control.js';
import { assertNoUrlCredentials } from './safe.js';
import { CollectionTransportError, UsageError, type CollectionFailureReason, type CollectOptions, type ContextWarning, type SiteContext } from '../types.js';

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

export async function collectRest(options: CollectOptions): Promise<SiteContext> {
  if (!options.wpUrl) throw new UsageError('REST collector requires --wp-url.');
  assertNoUrlCredentials(options.wpUrl, '--wp-url');
  const base = siteRoot(options.wpUrl);
  const auth = authorization(options);
  if (auth) requireSecureTransport(base);
  const concurrency = positiveOption(options.restConcurrency, DEFAULT_CONCURRENCY, '--rest-concurrency');
  const maxResponseBytes = positiveOption(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, '--max-response-bytes');
  const control = collectionControl(options);
  const warnings: ContextWarning[] = [];
  const raw: Record<string, unknown> = { warnings };
  let successfulRequests = 0;
  let responseBytes = 0;
  const startedAt = performance.now();
  const readJson = async (url: string): Promise<unknown> => {
    control.throwIfAborted();
    const response = await getJson(url, auth, control.signal, maxResponseBytes);
    control.throwIfAborted();
    successfulRequests += 1; responseBytes += response.bytes;
    return response.value;
  };
  const endpoint = (path: string, fields: string, extra: Record<string, string> = {}): string => {
    const url = new URL(`${base}/wp-json/${path}`);
    url.searchParams.set('_fields', fields);
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
    return url.toString();
  };
  const slices: Slice[] = [
    { surface: 'site', async run() { const index = await readJson(endpoint('', 'name')) as { name?: string }; return { site: { url: base, name: index.name ?? '', environment: 'unknown', isMultisite: false } }; } },
    { surface: 'theme', async run() {
      const themes = await readJson(endpoint('wp/v2/themes', 'stylesheet,template,name,version,is_block_theme', { status: 'active' })) as Array<{ stylesheet?: string; template?: string; name?: { rendered?: string } | string; version?: string; is_block_theme?: boolean }>;
      if (!Array.isArray(themes)) throw malformed(); const theme = themes[0]; let settings: unknown;
      if (theme?.stylesheet) { const styles = await readJson(endpoint(`wp/v2/global-styles/themes/${encodeURIComponent(theme.stylesheet)}`, 'settings', { context: auth ? 'edit' : 'view' })); const styleRecord = record(styles); if (!styleRecord) throw malformed(); settings = styleRecord.settings; }
      return { theme: { stylesheet: theme?.stylesheet, template: theme?.template, name: themeName(theme?.name), version: theme?.version, isBlockTheme: theme?.is_block_theme, settings } };
    } },
    { surface: 'blocks', async run() {
      const blocks = await readJson(endpoint('wp/v2/block-types', 'name,api_version,title,category,attributes,supports')) as Array<Record<string, unknown>>;
      if (!Array.isArray(blocks) || blocks.some((block) => typeof block.name !== 'string')) throw malformed();
      return { blocks: { types: blocks.map((block) => ({ name: block.name, apiVersion: block.api_version ?? null, title: block.title ?? null, category: block.category ?? null, attributes: block.attributes ?? {}, supports: block.supports ?? {}, source: String(block.name).startsWith('core/') ? 'core' : 'plugin' })) } };
    } },
    { surface: 'contentModel', async run() {
      const types = await readJson(endpoint('wp/v2/types', 'name,viewable,taxonomies')); const typeMap = record(types); if (!typeMap) throw malformed();
      return { contentModel: { postTypes: Object.entries(typeMap).map(([name, value]) => { const type = record(value) ?? {}; return { name, label: type.name, public: Boolean(type.viewable), showInRest: true, taxonomies: Array.isArray(type.taxonomies) ? type.taxonomies : [], fields: CORE_POST_DATA_FIELDS.map((field) => ({ ...field, args: { ...field.args } })) }; }) } };
    } },
    { surface: 'patterns', async run() {
      const patterns = await readJson(endpoint('wp/v2/block-patterns/patterns', 'name,title,categories,block_types,post_types')) as Array<Record<string, unknown>>;
      if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern.name !== 'string')) throw malformed();
      return { patterns: { items: patterns.map((pattern) => ({ name: pattern.name, title: pattern.title ?? null, categories: pattern.categories ?? [], blockTypes: pattern.block_types ?? [], postTypes: pattern.post_types ?? [] })) } };
    } },
  ];
  try {
    const outcomes = await boundedAll(slices, concurrency);
    control.throwIfAborted();
    for (const [index, result] of outcomes.entries()) { const slice = slices[index]!; if (result.status === 'fulfilled') Object.assign(raw, result.value); else warnings.push(sliceWarning(slice.surface, result.reason)); }
    if (!('site' in raw)) raw.site = { url: base, environment: 'unknown', isMultisite: false };
    if ('theme' in raw) warnings.push({ code: 'theme.rest_customization_layer', severity: 'info', surface: 'theme.settings', message: 'REST global-styles returns the user-customization layer, not the fully merged theme.json defaults; pure-theme-default tokens may be under-reported. Use get-site-context as the baseline.', coverage: 'partial' });
    if ('contentModel' in raw) warnings.push({ code: 'content_model.rest_meta_unavailable', severity: 'info', surface: 'contentModel', message: 'Registered post meta is not enumerable over the core REST API; only core post-data fields are reported.', coverage: 'partial' });
    warnings.push(
      { code: 'wordpress.rest_unavailable', severity: 'info', surface: 'wordpress', message: 'WordPress version/features are not exposed over the core REST API.', coverage: 'unavailable' },
      { code: 'bindings.rest_unavailable', severity: 'info', surface: 'bindings', message: 'Block binding sources are not exposed over the core REST API.', coverage: 'unavailable' },
      { code: 'plugins.rest_unavailable', severity: 'info', surface: 'plugins', message: 'Plugins are not retrievable over REST without elevated capabilities.', coverage: 'unavailable' },
      { code: 'media.rest_unavailable', severity: 'info', surface: 'media', message: 'Registered image sizes are not exposed over core REST API.', coverage: 'unavailable' },
    );
    if (successfulRequests === 0) throw new CollectionTransportError('REST collector could not communicate with any REST endpoint.', 'transport_failed');
    raw.provenance = { collectionMetrics: { latencyMs: Math.round(performance.now() - startedAt), responseBytes, requests: successfulRequests } };
    return normalizeCollectorOutput(raw, { collector: 'rest', collectorVersion: COLLECTOR_VERSION });
  } finally { control.dispose(); }
}

async function boundedAll<T>(slices: Slice[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(slices.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, slices.length) }, async () => { while (next < slices.length) { const index = next++; try { results[index] = { status: 'fulfilled', value: await slices[index]!.run() as T }; } catch (reason) { results[index] = { status: 'rejected', reason }; } } }));
  return results;
}
async function getJson(url: string, auth: string, collectionSignal: AbortSignal, maxBytes: number): Promise<JsonResult> {
  const request = new AbortController(); const timer = setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS); const signal = AbortSignal.any([collectionSignal, request.signal]);
  try {
    const response = await fetch(url, { headers: auth ? { Authorization: auth } : {}, signal });
    if (!response.ok) throw httpFailure(response.status);
    const length = Number(response.headers?.get?.('content-length')); if (Number.isFinite(length) && length > maxBytes) throw tooLarge();
    const text = await boundedText(response, maxBytes); try { return { value: JSON.parse(text), bytes: Buffer.byteLength(text) }; } catch { throw malformed(); }
  } catch (error) {
    if (error instanceof CollectionTransportError) throw error;
    if (collectionSignal.aborted) throw new CollectionTransportError('Collection was cancelled.', 'cancelled');
    if (request.signal.aborted) throw new CollectionTransportError('REST request timed out.', 'timeout');
    throw new CollectionTransportError('REST request failed.', 'transport_failed');
  } finally { clearTimeout(timer); }
}
async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) { if (typeof response.text !== 'function') return JSON.stringify(await response.json()); const text = await response.text(); if (Buffer.byteLength(text) > maxBytes) throw tooLarge(); return text; }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength; if (total > maxBytes) { await reader.cancel(); throw tooLarge(); } chunks.push(part.value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return new TextDecoder().decode(bytes);
}
function sliceWarning(surface: string, error: unknown): ContextWarning { const reason = error instanceof CollectionTransportError ? error.reason ?? 'transport_failed' : 'transport_failed'; const labels: Record<string, string> = { route_unavailable: 'unavailable route', authentication_failed: 'authentication failure', permission_denied: 'permission denied', timeout: 'timeout', response_too_large: 'oversized response', malformed_response: 'malformed response', cancelled: 'cancellation', deadline_exceeded: 'deadline exceeded', transport_failed: 'transport failure' }; return { code: `${surface}.rest_unavailable`, severity: 'warning', surface, reason, message: `REST ${surface} evidence could not be retrieved (${labels[reason] ?? 'transport failure'}).`, coverage: 'unavailable' }; }
function httpFailure(status: number): CollectionTransportError { const reason: CollectionFailureReason = status === 401 ? 'authentication_failed' : status === 403 ? 'permission_denied' : status === 404 ? 'route_unavailable' : 'transport_failed'; return new CollectionTransportError('REST request was rejected.', reason); }
function malformed(): CollectionTransportError { return new CollectionTransportError('REST response was malformed.', 'malformed_response'); }
function tooLarge(): CollectionTransportError { return new CollectionTransportError('REST response exceeded the configured size limit.', 'response_too_large'); }
function positiveOption(value: number | undefined, fallback: number, flag: string): number { const chosen = value ?? fallback; if (!Number.isSafeInteger(chosen) || chosen <= 0) throw new UsageError(`${flag} must be a positive integer.`); return chosen; }
function authorization(options: CollectOptions): string { const user = options.wpUser ?? ''; const password = options.wpAppPassword ?? ''; if (Boolean(user) !== Boolean(password)) throw new UsageError('REST collector requires both --wp-user and an Application Password, or neither.'); return user ? `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` : ''; }
function siteRoot(wpUrl: string): string { const base = wpUrl.replace(/\/+$/, '').replace(/\/wp-json$/, ''); try { const url = new URL(base); if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(); return base; } catch { throw new UsageError('REST collector requires a valid absolute --wp-url.'); } }
function requireSecureTransport(wpUrl: string): void { const url = new URL(wpUrl); const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'; if (url.protocol !== 'https:' && !local) throw new UsageError('REST collector refuses to send an Application Password over a non-HTTPS connection. Use an https:// URL (localhost excepted).'); }
function themeName(name: { rendered?: string } | string | undefined): string | undefined { return typeof name === 'string' ? name : name?.rendered; }
function record(value: unknown): Record<string, any> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined; }
