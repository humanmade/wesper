import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalize, sourceHash } from '../canonical.js';
import { redactSecrets } from '../redact.js';
import { siteContextSchema } from '../schema.js';
import { parseThemeJsonSettings, themeWarnings } from '../theme.js';
import { CONTEXT_VERSION, SCHEMA_URL, type CollectOptions, type ContextWarning, type SiteContext } from '../types.js';

const execFileAsync = promisify(execFile);
const COLLECTOR_VERSION = '0.1.0';

export async function collectWpCli(options: CollectOptions): Promise<SiteContext> {
  if (!options.wpPath && !options.ssh) {
    throw new Error('WP-CLI collector requires --wp-path or --ssh.');
  }

  const wpBinary = options.wpBinary ?? 'wp';
  const args = wpArgs(options, ['eval', PHP_COLLECTOR]);
  const { stdout } = await execFileAsync(wpBinary, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });

  const raw = parseCollectorJson(stdout);
  return normalizeCollectorOutput(raw);
}

function wpArgs(options: CollectOptions, command: string[]): string[] {
  const args: string[] = [];
  if (options.ssh) {
    args.push(`--ssh=${options.ssh}`);
  }
  if (options.wpPath) {
    args.push(`--path=${options.wpPath}`);
  }
  if (options.wpUrl) {
    args.push(`--url=${options.wpUrl}`);
  }
  args.push(...command);
  return args;
}

function parseCollectorJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('WP-CLI collector did not return JSON.');
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
}

function normalizeCollectorOutput(raw: Record<string, unknown>): SiteContext {
  const warnings = warningArray(raw.warnings);
  const bindingsRaw = record(raw.bindings);
  const themeRaw = record(raw.theme);
  const settings = themeRaw.settings;
  warnings.push(...themeWarnings(settings));

  const contextWithoutHash = redactSecrets({
    $schema: SCHEMA_URL,
    contextVersion: CONTEXT_VERSION,
    site: record(raw.site),
    provenance: {
      collectedAt: new Date().toISOString(),
      collector: 'wp-cli',
      collectorVersion: COLLECTOR_VERSION,
      sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      partial: warnings.some((warning) => warning.severity !== 'info'),
    },
    wordpress: record(raw.wordpress),
    theme: {
      ...themeRaw,
      settingsOrigin: 'merged',
      themeJsonHash: settings ? sourceHash({ settings }) : undefined,
      tokens: parseThemeJsonSettings(settings),
      settings,
    },
    plugins: array(raw.plugins),
    blocks: {
      types: sortByName(array(record(raw.blocks).types)),
    },
    bindings: {
      available: Boolean(bindingsRaw.available),
      sources: sortByName(array(bindingsRaw.sources)),
      supportedAttributes: sortSupportedAttributes(record(bindingsRaw.supportedAttributes)),
      warnings: warningArray(bindingsRaw.warnings),
    },
    contentModel: {
      postTypes: sortPostTypes(array(record(raw.contentModel).postTypes)),
    },
    patterns: {
      items: sortByName(array(record(raw.patterns).items)),
    },
    media: record(raw.media),
    warnings,
  });

  const context = {
    ...contextWithoutHash,
    provenance: {
      ...(contextWithoutHash.provenance as Record<string, unknown>),
      sourceHash: sourceHash(contextWithoutHash),
    },
  };

  return siteContextSchema.parse(context);
}

function warningArray(value: unknown): ContextWarning[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((warning): warning is ContextWarning => {
    return Boolean(
      warning &&
        typeof warning === 'object' &&
        typeof (warning as ContextWarning).code === 'string' &&
        typeof (warning as ContextWarning).severity === 'string' &&
        typeof (warning as ContextWarning).message === 'string' &&
        typeof (warning as ContextWarning).surface === 'string',
    );
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? (value.filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>>)
    : [];
}

function sortByName(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...items].sort((left, right) => String(left.name ?? '').localeCompare(String(right.name ?? '')));
}

function sortPostTypes(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return sortByName(items).map((postType) => ({
    ...postType,
    fields: sortByName(array(postType.fields)),
    taxonomies: Array.isArray(postType.taxonomies) ? [...postType.taxonomies].sort() : [],
  }));
}

function sortSupportedAttributes(value: Record<string, unknown>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([blockName, attributes]) => [
        blockName,
        Array.isArray(attributes) ? attributes.map(String).sort() : [],
      ]),
  );
}

export function collectorSourceForTests(): string {
  return PHP_COLLECTOR;
}

const PHP_COLLECTOR = String.raw`
$warnings = array();

function wesper_warning($code, $surface, $message, $severity = 'warning') {
    return array(
        'code' => $code,
        'severity' => $severity,
        'surface' => $surface,
        'message' => $message,
    );
}

function wesper_public_props($object, $props) {
    $out = array();
    foreach ($props as $from => $to) {
        if (is_int($from)) {
            $from = $to;
        }
        if (is_object($object) && isset($object->{$from})) {
            $out[$to] = $object->{$from};
        } elseif (is_array($object) && array_key_exists($from, $object)) {
            $out[$to] = $object[$from];
        }
    }
    return $out;
}

global $wp_version;

$theme = wp_get_theme();
$settings = function_exists('wp_get_global_settings') ? wp_get_global_settings() : array();

$plugins = array();
if (!function_exists('get_plugin_data')) {
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
}
$active_plugins = (array) get_option('active_plugins', array());
$network_plugins = is_multisite() ? array_keys((array) get_site_option('active_sitewide_plugins', array())) : array();
foreach (array_values(array_unique(array_merge($active_plugins, $network_plugins))) as $plugin_file) {
    $plugin_path = WP_PLUGIN_DIR . '/' . $plugin_file;
    $data = file_exists($plugin_path) ? get_plugin_data($plugin_path, false, false) : array();
    $plugins[] = array(
        'slug' => $plugin_file,
        'name' => isset($data['Name']) && $data['Name'] ? $data['Name'] : $plugin_file,
        'version' => isset($data['Version']) ? $data['Version'] : '',
        'active' => in_array($plugin_file, $active_plugins, true),
        'networkActive' => in_array($plugin_file, $network_plugins, true),
    );
}

$block_types = array();
foreach (WP_Block_Type_Registry::get_instance()->get_all_registered() as $name => $block_type) {
    $block_types[] = array(
        'name' => $name,
        'apiVersion' => isset($block_type->api_version) ? $block_type->api_version : null,
        'title' => isset($block_type->title) ? $block_type->title : null,
        'category' => isset($block_type->category) ? $block_type->category : null,
        'attributes' => isset($block_type->attributes) ? $block_type->attributes : array(),
        'supports' => isset($block_type->supports) ? $block_type->supports : array(),
        'source' => strpos($name, 'core/') === 0 ? 'core' : 'plugin',
    );
}

$binding_sources = array();
$bindings_available = function_exists('get_all_registered_block_bindings_sources');
if ($bindings_available) {
    foreach (get_all_registered_block_bindings_sources() as $name => $source) {
        $binding_sources[] = array(
            'name' => $name,
            'label' => isset($source->label) ? $source->label : null,
            'usesContext' => isset($source->uses_context) ? array_values((array) $source->uses_context) : array(),
            'argsSchema' => null,
        );
    }
} else {
    $warnings[] = wesper_warning('bindings.unavailable', 'bindings', 'Block Bindings are unavailable before WordPress 6.5.');
}

$core_supported_attributes = array(
    'core/paragraph' => array('content'),
    'core/heading' => array('content'),
    'core/image' => array('id', 'url', 'title', 'alt', 'caption'),
    'core/button' => array('url', 'text', 'linkTarget', 'rel'),
    'core/post-date' => array('datetime'),
    'core/navigation-link' => array('url'),
    'core/navigation-submenu' => array('url'),
);
$supported_attributes = array();
if (function_exists('get_block_bindings_supported_attributes')) {
    foreach ($block_types as $block_type) {
        $attrs = get_block_bindings_supported_attributes($block_type['name']);
        if (!empty($attrs)) {
            $supported_attributes[$block_type['name']] = array_values($attrs);
        }
    }
} else {
    $supported_attributes = $core_supported_attributes;
    $warnings[] = wesper_warning('bindings.supported_attributes_partial', 'bindings.supportedAttributes', 'WordPress does not expose get_block_bindings_supported_attributes(); using documented core compatibility table.');
}

$post_types = array();
foreach (get_post_types(array(), 'objects') as $post_type_name => $post_type_object) {
    $fields = array(
        array('key' => 'title', 'source' => 'core/post-data', 'type' => 'string', 'bindable' => true),
        array('key' => 'excerpt', 'source' => 'core/post-data', 'type' => 'string', 'bindable' => true),
        array('key' => 'featured_media', 'source' => 'core/post-data', 'type' => 'integer', 'bindable' => true),
    );
    $registered_meta = function_exists('get_registered_meta_keys') ? get_registered_meta_keys('post', $post_type_name) : array();
    foreach ($registered_meta as $meta_key => $args) {
        $show_in_rest = !empty($args['show_in_rest']);
        $protected = isset($args['protected']) ? (bool) $args['protected'] : strpos((string) $meta_key, '_') === 0;
        if (!$show_in_rest || $protected) {
            continue;
        }
        $fields[] = array(
            'key' => (string) $meta_key,
            'source' => 'core/post-meta',
            'type' => isset($args['type']) ? (string) $args['type'] : 'string',
            'single' => isset($args['single']) ? (bool) $args['single'] : false,
            'showInRest' => true,
            'bindable' => true,
        );
    }
    if (empty($registered_meta)) {
        $warnings[] = wesper_warning('content_model.no_registered_meta', 'contentModel.postTypes.' . $post_type_name . '.fields', 'No registered REST-visible meta was discovered for this post type.', 'info');
    }
    $post_types[] = array(
        'name' => $post_type_name,
        'label' => $post_type_object->label,
        'public' => (bool) $post_type_object->public,
        'showInRest' => (bool) $post_type_object->show_in_rest,
        'taxonomies' => array_values(get_object_taxonomies($post_type_name)),
        'fields' => $fields,
    );
}

$patterns = array();
if (class_exists('WP_Block_Patterns_Registry')) {
    foreach (WP_Block_Patterns_Registry::get_instance()->get_all_registered() as $name => $pattern) {
        $patterns[] = array(
            'name' => $name,
            'title' => isset($pattern['title']) ? $pattern['title'] : null,
            'categories' => isset($pattern['categories']) ? array_values((array) $pattern['categories']) : array(),
            'blockTypes' => isset($pattern['blockTypes']) ? array_values((array) $pattern['blockTypes']) : array(),
            'postTypes' => isset($pattern['postTypes']) ? array_values((array) $pattern['postTypes']) : array(),
        );
    }
}

$output = array(
    'site' => array(
        'url' => get_bloginfo('url'),
        'name' => get_bloginfo('name'),
        'environment' => function_exists('wp_get_environment_type') ? wp_get_environment_type() : 'unknown',
        'isMultisite' => is_multisite(),
    ),
    'wordpress' => array(
        'version' => $wp_version,
        'locale' => get_locale(),
        'permalinkStructure' => (string) get_option('permalink_structure'),
        'features' => array(
            'blockBindings' => $bindings_available,
            'blockBindingsSupportedAttributesApi' => function_exists('get_block_bindings_supported_attributes'),
            'patterns' => class_exists('WP_Block_Patterns_Registry'),
        ),
    ),
    'theme' => array(
        'stylesheet' => $theme->get_stylesheet(),
        'template' => $theme->get_template(),
        'name' => (string) $theme->get('Name'),
        'version' => (string) $theme->get('Version'),
        'isBlockTheme' => function_exists('wp_is_block_theme') ? wp_is_block_theme() : false,
        'settings' => $settings,
    ),
    'plugins' => $plugins,
    'blocks' => array('types' => $block_types),
    'bindings' => array(
        'available' => $bindings_available,
        'sources' => $binding_sources,
        'supportedAttributes' => $supported_attributes,
        'warnings' => array(),
    ),
    'contentModel' => array('postTypes' => $post_types),
    'patterns' => array('items' => $patterns),
    'media' => array(
        'imageSizes' => function_exists('wp_get_registered_image_subsizes') ? array_values(array_map(function($name, $size) {
            return array(
                'name' => $name,
                'width' => isset($size['width']) ? $size['width'] : 0,
                'height' => isset($size['height']) ? $size['height'] : 0,
                'crop' => isset($size['crop']) ? (bool) $size['crop'] : false,
            );
        }, array_keys(wp_get_registered_image_subsizes()), wp_get_registered_image_subsizes())) : array(),
        'maxUploadSize' => function_exists('wp_max_upload_size') ? wp_max_upload_size() : null,
    ),
    'warnings' => $warnings,
);

echo wp_json_encode($output);
`;
