/*
 * Executable contract against WordPress, not mocks. Run via
 * integration/wordpress/run-real-wordpress.sh (WORDPRESS_VERSION selects a
 * matrix member). Fixtures contain no private-site content.
 */
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { collect, sourceHash, stringifyManifest, validate } from '../../src/index.js';
import { coverageFor } from '../../src/warnings.js';

const url = required('WESPER_TEST_URL');
const user = required('WESPER_TEST_USER');
const password = required('WESPER_TEST_APP_PASSWORD');
const wp = new URL('./integration/wordpress/bin/wp-compose', `file://${process.cwd()}/`).pathname;

const wpOptions = { collector: 'wp-cli' as const, wpBinary: wp, wpPath: '/var/www/html' };
const [first, second] = await Promise.all([collect(wpOptions), collect(wpOptions)]);
const execFile = promisify(execFileCallback);

// Source hashing must be independent of collection time and PHP registry order.
assert.equal(first.provenance.sourceHash, second.provenance.sourceHash);
assert.equal(first.provenance.sourceHash, sourceHash(first));
const saved = await mkdtemp(join(tmpdir(), 'wesper-contract-'));
try {
  const manifest = join(saved, 'site.context.json');
  await writeFile(manifest, stringifyManifest(first));
  assert.equal(validate(JSON.parse(stringifyManifest(first))).ok, true);
  await cli('validate', manifest);
  await cli('summarize', manifest, '--format', 'json');
} finally {
  await rm(saved, { recursive: true, force: true });
}

assert.equal(first.theme?.settingsOrigin, 'merged');
const tokens = first.theme?.tokens?.colors ?? [];
const shared = tokens.find((token) => token.slug === 'wesper-shared');
assert.deepEqual(shared && {
  value: shared.value, origin: shared.origin, css: shared.references.cssCustomProperty,
  style: shared.references.blockStyle,
}, { value: '#224466', origin: 'user', css: '--wp--preset--color--wesper-shared', style: 'var:preset|color|wesper-shared' });
assert.ok(tokens.some((token) => token.slug === 'wesper-theme-only'));
assert.ok(tokens.some((token) => token.slug === 'wesper-user-only'));
const sharedFontSize = first.theme?.tokens?.fontSizes.find((token) => token.slug === 'wesper-shared');
assert.deepEqual(sharedFontSize && {
  id: sharedFontSize.id, value: sharedFontSize.value, origin: sharedFontSize.origin,
  css: sharedFontSize.references.cssCustomProperty, style: sharedFontSize.references.blockStyle,
}, { id: 'font-size:wesper-shared', value: '20px', origin: 'user', css: '--wp--preset--font-size--wesper-shared', style: 'var:preset|font-size|wesper-shared' });
assert.notEqual(shared?.id, sharedFontSize?.id, 'identical slugs remain distinct across token kinds');

const post = first.contentModel?.postTypes.find((type) => type.name === 'post');
assert.ok(post, 'the real post type must be observed');
const fields = new Map(post.fields.map((field) => [field.key, field]));
assert.equal(fields.get('wesper_global_meta')?.source, 'core/post-meta');
assert.equal(fields.get('wesper_subtype_meta')?.type, 'integer');
assert.ok(!fields.has('wesper_token_collision'), 'the globally hidden collision wins over the REST-visible subtype registration');
assert.ok(!fields.has('wesper_filtered_meta'), 'is_protected_meta filter excludes protected registrations');

const core = await wpJson(`
  $subtype = get_registered_meta_keys('post', 'post');
  $global = get_registered_meta_keys('post', '');
  $sources = array_keys(get_all_registered_block_bindings_sources());
	$post = get_page_by_title('Wesper fixture', OBJECT, 'post');
	$effective_collision = _block_bindings_post_meta_get_value(
		array('key' => 'wesper_token_collision'),
		(object) array('context' => array('postId' => $post->ID, 'postType' => 'post'))
	);
  echo wp_json_encode(array(
    'subtype' => $subtype['wesper_token_collision'],
    'global' => $global['wesper_token_collision'],
	'effectiveCollision' => $effective_collision,
    'protected' => is_protected_meta('wesper_filtered_meta', 'post'),
    'sources' => $sources
  ));
`);
assert.equal(core.subtype.type, 'integer');
assert.equal(core.global.type, 'string');
assert.equal(core.effectiveCollision, null, 'the core post-meta binding lookup uses the global collision registration');
assert.equal(core.protected, true);
assert.ok(first.bindings?.sources.some((source) => source.name === 'wesper/contract-source'));
assert.equal(first.bindings?.sources.some((source) => source.name === 'core/post-data'), core.sources.includes('core/post-data'));
assert.equal(post.fields.some((field) => field.source === 'core/post-data'), core.sources.includes('core/post-data'), 'an absent source produces no invented fields');
assert.ok(first.patterns?.items.some((pattern) => pattern.name === 'wesper-contract/registered-pattern'));
assert.ok(coverageFor(first, ['blocks', 'contentModel', 'patterns']).every((entry) => entry.status === 'complete'));

// Authenticated and anonymous REST calls establish permitted and denied core
// surfaces. Their overlap is compared only where REST and WP-CLI are intended
// to describe the same API surface.
const observedMethods: string[] = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  observedMethods.push(init?.method ?? (input instanceof Request ? input.method : 'GET'));
  return nativeFetch(input, init);
};
let permitted;
let denied;
try {
  permitted = await collect({ collector: 'rest', wpUrl: url, wpUser: user, wpAppPassword: password });
  denied = await collect({ collector: 'rest', wpUrl: url });
} finally { globalThis.fetch = nativeFetch; }
assert.ok(observedMethods.length > 0 && observedMethods.every((method) => method === 'GET'), 'REST collection only issued read requests');
assert.ok(permitted.blocks?.types.length, 'authenticated REST exposes block types');
const anonymousTheme = await anonymousRequest('/wp-json/wp/v2/themes?status=active');
assert.ok([401, 403].includes(anonymousTheme.status), 'anonymous core theme access is explicitly denied');
const deniedThemeCoverage = coverageFor(denied, ['theme'])[0]!;
assert.equal(deniedThemeCoverage.status, 'unavailable', 'the denied theme endpoint is represented as unavailable coverage');
assert.ok(deniedThemeCoverage.warnings.some((warning) => warning.reason === 'authentication_failed' || warning.reason === 'permission_denied'), 'theme coverage records the core denial reason');
assert.ok(permitted.patterns?.items.some((pattern) => pattern.name === 'wesper-contract/registered-pattern'), 'REST exposes the controlled fixture pattern');
const coreBlocks = await restJson('/wp-json/wp/v2/block-types?_fields=name');
const corePatterns = await restJson('/wp-json/wp/v2/block-patterns/patterns?_fields=name');
assert.ok(corePatterns.some((pattern: { name: string }) => pattern.name === 'wesper-contract/registered-pattern'));
assert.deepEqual(
  permitted.blocks?.types.map((block) => block.name).sort(),
  coreBlocks.map((block: { name: string }) => block.name).sort(),
  'block registry names agree across WP-CLI and real REST',
);
assert.deepEqual(first.blocks?.types.map((block) => block.name).sort(), coreBlocks.map((block: { name: string }) => block.name).sort());
assert.equal(permitted.theme?.settingsOrigin, 'theme');
assert.equal(permitted.provenance.partial, true, 'REST explicitly records unavailable native-only surfaces');
assert.ok(permitted.theme?.tokens?.colors.some((token) => token.slug === 'wesper-theme-only'));
assert.ok(!permitted.theme?.tokens?.colors.some((token) => token.slug === 'wesper-user-only'), 'REST is compared with its theme-only surface, not merged user settings');

function required(name: string): string {
  const value = process.env[name];
  assert.ok(value, `${name} must be set by run-real-wordpress.sh`);
  return value;
}

async function wpJson(php: string): Promise<any> {
  const { stdout } = await execFile(wp, ['--path=/var/www/html', 'eval', php]);
  return JSON.parse(stdout);
}

async function restJson(path: string): Promise<any> {
  const response = await nativeRequest(path);
  assert.equal(response.status, 200, `core REST request succeeded: ${path}`);
  return response.json();
}

function nativeRequest(path: string): Promise<Response> {
  const target = new URL(path, `${url}/`);
  return nativeFetch(target, { headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } });
}

function anonymousRequest(path: string): Promise<Response> {
  return nativeFetch(new URL(path, `${url}/`));
}

async function cli(...args: string[]): Promise<void> {
  try {
    await execFile('npx', ['tsx', 'src/cli.ts', ...args]);
  } catch (error: any) {
    assert.ok([0, 1].includes(error.code), `CLI command ran: ${error.message}`);
  }
}
