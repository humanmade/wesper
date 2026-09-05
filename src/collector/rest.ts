import { COLLECTOR_VERSION, normalizeCollectorOutput } from './normalize.js';
import { assertNoUrlCredentials } from './safe.js';
import { CollectionTransportError, UsageError, type CollectOptions, type ContextWarning, type SiteContext } from '../types.js';

const REQUEST_TIMEOUT_MS = 10_000;

// Core REST does not expose the binding-source registry. These fields are
// useful content-model evidence, but cannot be advertised as binding-ready
// without a reported source.
const CORE_POST_DATA_FIELDS = [
  { name: 'date', key: 'date', source: 'core/post-data', args: { field: 'date' }, type: 'string', bindable: false },
  { name: 'modified', key: 'modified', source: 'core/post-data', args: { field: 'modified' }, type: 'string', bindable: false },
  { name: 'link', key: 'link', source: 'core/post-data', args: { field: 'link' }, type: 'string', bindable: false },
];

export async function collectRest(options: CollectOptions): Promise<SiteContext> {
  if (!options.wpUrl) {
    throw new UsageError('REST collector requires --wp-url.');
  }

  assertNoUrlCredentials(options.wpUrl, '--wp-url');
  const base = siteRoot(options.wpUrl);
  const auth = authorization(options);
  if (auth) {
    requireSecureTransport(base);
  }
  const context = auth ? 'edit' : 'view';

  const warnings: ContextWarning[] = [];
  const raw: Record<string, unknown> = { warnings };
  let successfulRequests = 0;
  const readJson = async (url: string): Promise<unknown> => {
    const response = await getJson(url, auth);
    successfulRequests += 1;
    return response;
  };

  // site
  try {
    const index = (await readJson(`${base}/wp-json/`)) as { name?: string; description?: string };
    raw.site = { url: base, name: index.name ?? '', environment: 'unknown', isMultisite: false };
  } catch {
    raw.site = { url: base, environment: 'unknown', isMultisite: false };
    warnings.push({
      code: 'site.rest_unavailable',
      severity: 'warning',
      surface: 'site',
      message: 'The REST API root index could not be read; site name is omitted.',
      coverage: 'partial',
    });
  }

  // wordpress — not reliably exposed over core REST
  warnings.push({
    code: 'wordpress.rest_unavailable',
    severity: 'info',
    surface: 'wordpress',
    message: 'WordPress version/features are not exposed over the core REST API.',
    coverage: 'unavailable',
  });

  // theme + global-styles
  try {
    const themes = (await readJson(`${base}/wp-json/wp/v2/themes?status=active`)) as Array<{
      stylesheet?: string;
      template?: string;
      name?: { rendered?: string } | string;
      version?: string;
      is_block_theme?: boolean;
    }>;
    const theme = themes[0];
    const stylesheet = theme?.stylesheet;
    let settings: unknown;
    if (stylesheet) {
      const globalStyles = (await readJson(
        `${base}/wp-json/wp/v2/global-styles/themes/${encodeURIComponent(stylesheet)}?context=${context}`,
      )) as { settings?: unknown };
      settings = globalStyles.settings ?? undefined;
    }
    raw.theme = {
      stylesheet,
      template: theme?.template,
      name: themeName(theme?.name),
      version: theme?.version,
      isBlockTheme: theme?.is_block_theme,
      settings,
    };
    warnings.push({
      code: 'theme.rest_theme_layer',
      severity: 'info',
      surface: 'theme.settings',
      message:
        'REST global-styles themes returns the core, block, and theme layer; user customizations are not included. Use WP-CLI collection for merged effective settings.',
      coverage: 'partial',
    });
  } catch {
    warnings.push({
      code: 'theme.rest_unavailable',
      severity: 'warning',
      surface: 'theme',
      message: 'Theme or global-styles could not be retrieved over the core REST API.',
      coverage: 'unavailable',
    });
  }

  // blocks
  try {
    const blockTypes = (await readJson(`${base}/wp-json/wp/v2/block-types`)) as Array<{
      name: string;
      api_version?: number;
      title?: string;
      category?: string;
      attributes?: Record<string, unknown>;
      supports?: Record<string, unknown>;
    }>;
    const types = blockTypes.map((blockType) => ({
      name: blockType.name,
      apiVersion: blockType.api_version ?? null,
      title: blockType.title ?? null,
      category: blockType.category ?? null,
      attributes: blockType.attributes ?? {},
      supports: blockType.supports ?? {},
      source: blockType.name.startsWith('core/') ? 'core' : 'plugin',
    }));
    raw.blocks = { types };
  } catch {
    warnings.push({
      code: 'blocks.rest_unavailable',
      severity: 'warning',
      surface: 'blocks',
      message: 'Block types could not be retrieved over the core REST API.',
      coverage: 'unavailable',
    });
  }

  // contentModel
  try {
    const restTypes = (await readJson(`${base}/wp-json/wp/v2/types`)) as Record<
      string,
      { name?: string; viewable?: boolean; taxonomies?: string[] }
    >;
    const postTypes = Object.entries(restTypes).map(([slug, type]) => ({
      name: slug,
      label: type.name,
      public: Boolean(type.viewable),
      showInRest: true,
      taxonomies: type.taxonomies ?? [],
      fields: CORE_POST_DATA_FIELDS.map((field) => ({ ...field, args: { ...field.args } })),
    }));
    raw.contentModel = { postTypes };
    warnings.push({
      code: 'content_model.rest_meta_unavailable',
      severity: 'info',
      surface: 'contentModel',
      message:
        'Registered post meta is not enumerable over the core REST API; only core post-data fields are reported.',
      coverage: 'partial',
    });
  } catch {
    warnings.push({
      code: 'content_model.rest_unavailable',
      severity: 'warning',
      surface: 'contentModel',
      message: 'Post types could not be retrieved over the core REST API.',
      coverage: 'unavailable',
    });
  }

  // bindings — not exposed over core REST
  warnings.push({
    code: 'bindings.rest_unavailable',
    severity: 'info',
    surface: 'bindings',
    message: 'Block binding sources are not exposed over the core REST API.',
    coverage: 'unavailable',
  });

  // patterns
  try {
    const restPatterns = (await readJson(`${base}/wp-json/wp/v2/block-patterns/patterns`)) as Array<{
      name: string;
      title?: string;
      categories?: string[];
      block_types?: string[];
      post_types?: string[];
    }>;
    const items = restPatterns.map((pattern) => ({
      name: pattern.name,
      title: pattern.title ?? null,
      categories: pattern.categories ?? [],
      blockTypes: pattern.block_types ?? [],
      postTypes: pattern.post_types ?? [],
    }));
    raw.patterns = { items };
  } catch {
    warnings.push({
      code: 'patterns.rest_unavailable',
      severity: 'info',
      surface: 'patterns',
      message: 'Block patterns were not retrievable (endpoint may require additional capabilities).',
      coverage: 'unavailable',
    });
  }

  // plugins — not retrievable over REST without elevated capabilities
  warnings.push({
    code: 'plugins.rest_unavailable',
    severity: 'info',
    surface: 'plugins',
    message: 'Plugins are not retrievable over REST without elevated capabilities.',
    coverage: 'unavailable',
  });

  // media — registered image sizes not exposed over core REST
  warnings.push({
    code: 'media.rest_unavailable',
    severity: 'info',
    surface: 'media',
    message: 'Registered image sizes are not exposed over the core REST API.',
    coverage: 'unavailable',
  });

  if (successfulRequests === 0) {
    throw new CollectionTransportError('REST collector could not communicate with any REST endpoint.');
  }

  return normalizeCollectorOutput(raw, { collector: 'rest', collectorVersion: COLLECTOR_VERSION });
}

async function getJson(url: string, auth: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: auth ? { Authorization: auth } : {},
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`request failed: ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function siteRoot(wpUrl: string): string {
  // Accept either the site root or a URL that already includes the REST entry point,
  // so `--wp-url https://site.test/wp-json` does not produce `/wp-json/wp-json/...`.
  const base = wpUrl.replace(/\/+$/, '').replace(/\/wp-json$/, '');
  try {
    const url = new URL(base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
    return base;
  } catch {
    throw new UsageError(`REST collector requires a valid absolute --wp-url; received "${wpUrl}".`);
  }
}

function authorization(options: CollectOptions): string {
  const user = options.wpUser ?? '';
  const password = options.wpAppPassword ?? '';
  return user && password ? `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` : '';
}

function requireSecureTransport(wpUrl: string): void {
  let hostname: string;
  let protocol: string;
  try {
    const url = new URL(wpUrl);
    hostname = url.hostname;
    protocol = url.protocol;
  } catch {
    throw new UsageError(`REST collector requires a valid absolute --wp-url; received "${wpUrl}".`);
  }
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (protocol !== 'https:' && !isLocal) {
    throw new UsageError(
      'REST collector refuses to send an Application Password over a non-HTTPS connection. Use an https:// URL (localhost excepted).',
    );
  }
}

function themeName(name: { rendered?: string } | string | undefined): string | undefined {
  if (typeof name === 'string') {
    return name;
  }
  return name?.rendered;
}
