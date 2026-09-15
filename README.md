# Wesper

Wesper reads a WordPress site's configuration and registered capabilities and saves them as JSON. Other tools can use that file to inspect blocks, plugins, fields and theme settings. Wesper does not change the site or call AI models.

The output, `site.context.json`, records what was collected and where information is missing. A tool or agent can use it without reconnecting to WordPress. Block Runner is one consumer; Wesper also supports migration, editorial and diagnostic tools.

## Try it without WordPress

Use Node.js 20 or later. From an empty directory:

```sh
npm init -y
npm install wesper
npx wesper summarize node_modules/wesper/examples/fixtures/consumer-manifest.json
```

This reads the synthetic fixture shipped with Wesper. It needs no WordPress installation, credentials or AI model. The output includes:

```text
- Collector: fixture

## Counts

- Block types: 2
- Binding sources: 2
- Post types: 2
- Bindable fields: 4
- Patterns: 0
- Plugins: 0
```

This is an excerpt from sample data, not an inventory of your site. Its placeholder source hash does not assert integrity.

## Collect your site

For local collection, you need a working WordPress installation and WP-CLI (`wp`) on your `PATH`. Replace `./public` with the directory containing that installation:

```sh
npx wesper collect --wp-path ./public --out site.context.json
npx wesper summarize site.context.json
```

The first command reads WordPress and writes the JSON file. The second reads that saved file offline. Collection can return partial results; inspect the warnings and [coverage guidance](#native-references-and-coverage).

For a remote site, use [WP-CLI over SSH](#wp-cli) or the [core REST API](#rest). REST needs a reachable site URL; a WordPress username and Application Password give access to additional endpoints. Anonymous collection is supported but partial.

To use `wesper` without the `npx` prefix in the collector examples below, install the CLI globally:

```sh
npm install --global wesper
```

## Use the library

Save this as `collect-site.mjs` and run `node collect-site.mjs`. It has the same WordPress and WP-CLI prerequisites as local CLI collection:

```js
import { collect, summarize } from 'wesper';

const context = await collect({ collector: 'wp-cli', wpPath: './public' });
console.log(summarize(context));
```

`collect()` returns a normalised, validated manifest. To read saved JSON instead, validate it at the input boundary. Save this as `read-context.mjs` and run `node read-context.mjs site.context.json`:

```js
import { readFile } from 'node:fs/promises';
import { summarize, validate } from 'wesper';

const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const checked = validate(input);
if (!checked.ok || !checked.context) throw new Error('Invalid manifest');
console.log(summarize(checked.context));
```

You can also pass `node_modules/wesper/examples/fixtures/consumer-manifest.json` to this script. Validation checks the manifest contract and redacts credential-like values. It does not prove completeness, freshness or rendering behaviour, or verify the supplied source hash. See [the evidence and hashing rules](#binding-join).

## Collectors

Wesper supports exactly two read-only collectors: WP-CLI and the core WordPress REST API. It does not mutate WordPress.

### WP-CLI

For a local site, `wp` must be on `PATH` and the site must be selected with `--wp-path`:

```sh
wesper collect --wp-path ./public --out site.context.json
```

For SSH, WP-CLI must be available to the remote target. `--wp-path` is optional when remote WP-CLI can locate the install. On a multisite install, select the site with `--wp-url`:

```sh
wesper collect --ssh deploy@example.com --wp-path /var/www/site --wp-url https://example.com/blog --out site.context.json
```

WP-CLI produces merged theme settings and can collect registered Block Bindings sources and registered post meta. The collector uses a read-only `--exec` observer during the same WP-CLI process to capture post-type and taxonomy registration callers before its main `eval` payload runs. It installs no site code and changes no registrations.

### REST

REST accepts a site-root URL, such as `https://example.com`; a trailing slash or `/wp-json` is normalized. Use flags or the environment:

```sh
WP_API_URL=https://example.com \
WP_API_USERNAME=editor \
WP_API_PASSWORD='application password' \
wesper collect --rest --out site.context.json
```

`--wp-url` takes precedence over `WP_API_URL`, and `--wp-user` takes precedence over `WP_API_USERNAME`. The password is only read from `WP_API_PASSWORD`, never from a command-line flag. A username and Application Password must be supplied together, or neither may be supplied; anonymous partial collection is supported. Credentialed requests require HTTPS, except for `localhost`, `127.0.0.1`, and `::1`.

Library callers use the paired `wpUser` and `wpAppPassword` options:

```ts
await collect({
  collector: 'rest',
  wpUrl: 'https://example.com',
  wpUser: 'editor',
  wpAppPassword: process.env.WP_API_PASSWORD,
});
```

REST uses core endpoints only. It lacks binding-source evidence and registered-meta evidence (it reports only core post-data fields), so it cannot currently satisfy strict collection. It also reports theme settings from the core/block/theme layer rather than user customizations, and cannot retrieve some WordPress, plugin, and media evidence through core REST.

The REST collector handles subdirectory and query-route installations, with same-origin query fallback when pretty routes are unavailable. It requests post-type edit context when authorized and preserves useful slices when another slice is malformed. Taxonomy definition records and package ownership are currently WP-CLI-only; REST leaves these additions absent.

`timeoutMs`, `restConcurrency`, `maxResponseBytes`, and `AbortSignal` are available to library callers; corresponding REST CLI flags are available for the numeric limits.

## Native references and coverage

WP-CLI collection also reports must-use plugins, post-type hierarchy and supports, and registered block relationships, context, styles, asset handles, and WordPress's dynamic-render status. These are runtime registry facts. They do not reconstruct build paths, inspect editor `save()` implementations, imply that a dynamic block saves no child content, or prove front-end behavior. Optional attribution evidence is described separately below. REST reports the overlapping core block-type fields.

Native theme tokens include stable `id`, kind, slug, value, origin, and `references`: `cssCustomProperty`, `cssValue`, and `blockStyle`. For example, a colour token can produce `var:preset|color|primary` directly for a block style value. Wesper does not infer semantic roles from token names. Native-token coverage is distinct from theme-settings coverage: `theme.tokens.presets: []` proves an empty native registry, while settings-only and legacy token collections do not.

`lookupNativeToken`, `lookupBlock`, and `lookupField` perform exact token kind/slug, block name, and field key-or-name matches. They return `found`, `absent` only for complete evidence, or `unknown` for partial/unavailable evidence. A field lookup can additionally qualify its source. Field lookups preserve their reported `args` exactly; consumers should copy those binding arguments verbatim rather than inferring source-specific keys.

`focusContext` creates a deterministic narrowed view for explicitly selected post types, blocks, and token kinds. Omitted or empty selectors select nothing. Its `sourceManifestHash` identifies the parent manifest only; it is not a hash of the projection.

### Compatibility checks

`checkTokenReference` checks an explicit native-token `kind` and `slug`; `checkBindingReference` checks an explicit block, attribute, source, and field selector. Each returns `compatible`, `incompatible`, or `unknown`, with deterministic reasons, stable manifest identifiers, relevant warnings and coverage, plus the manifest `sourceManifestHash` behind the conclusion. Found evidence can establish compatibility even when coverage is partial; a missing reference is `unknown` under incomplete evidence, and only complete evidence can establish an absence.

Binding prerequisites are checked independently: the block, supported attribute, source, and exact source-qualified field must each be supported. Compatible field `args` are returned verbatim, never inferred or rewritten. These checks concern manifest compatibility only—not runtime rendering, permissions, post context, or semantic/design choices. They do not diagnose literals or propose replacements; a consumer that adds an opt-in literal suggestion must present its supporting evidence rather than treating every literal as wrong.

### Package attribution and taxonomies

The WP-CLI collector adds optional ownership evidence without changing the legacy block `source` classification:

| Field | Evidence | Meaning |
| --- | --- | --- |
| `blocks.types[].owner` | `block-metadata` | A registered block name matches a package's `block.json`; this identifies a package candidate, not the registration call. |
| `contentModel.postTypes[].owner` | `registration-call` | The observed registration call chain maps to one known package, or directly to core. |
| `contentModel.taxonomies[].owner` | `registration-call` | The same registration evidence for a taxonomy. |

A matched owner contains `status: "matched"`, `kind` (`core`, `plugin`, `mu-plugin`, or `theme`), `slug`, `evidence` and a `path` relative to its package directory. Plugin and MU-plugin slugs join to `plugins[].slug`; theme slugs refer to the stylesheet/template, and core uses `wordpress`. For core, block metadata paths are relative to `wp-includes/blocks`, while registration paths are relative to the WordPress installation. Unknown owners contain `status: "unknown"` and a `reason`, without a guessed slug. Older manifests and REST output can omit ownership entirely.

Taxonomy records contain `name`, label/visibility/hierarchy metadata, `objectTypes` associations and optional ownership. The existing `postTypes[].taxonomies` name lists remain intact. A missing taxonomy section is not an empty registry.

Nested MU packages enter the inventory only when PHP included a file with a plugin header. Block metadata scanning covers known package, theme and core directories, excluding `node_modules`, `vendor` and `.git`; it does not follow internal directory symlinks. Scans are bounded to 20,000 file entries and 1 MiB per metadata file. Incomplete scans leave block owners unknown. Registration traces exclude arguments, stay in process memory, and are limited to 64 frames; truncated traces and chains spanning multiple known packages remain unknown. Registrations outside known package roots, including some Composer dependencies, remain unmapped.

An isolated package means no relationships were captured for it. Ownership does not describe every later filter, prove safe removal, or establish a package's complete footprint. Pattern `blockTypes` entries are associations, including template areas such as `core/template-part/header`; they are not an inventory of blocks used inside pattern content.

The shared normalizer warns when supported binding attributes or `providesContext` mappings lack corresponding block attribute definitions. It preserves the reported registrations. These gaps make the affected evidence partial, but do not establish a runtime failure; a compatibility result can remain `compatible` with warnings. Consumers should inspect those warnings and perform the runtime check their task requires.

### Binding join

Before writing `metadata.bindings`, consumers join `bindings.supportedAttributes` (the bindable attributes reported for each block type) with `contentModel.postTypes[].fields` (the fields reported for the target post type). Each field carries ready-to-use `args`; copy them verbatim. In particular, do not invent `field` for `core/post-data` or `key` for `core/post-meta`—Wesper owns that source-specific syntax.

The field's source must be one of the reported `bindings.sources`; `bindings.available: false` means that binding evidence was explicitly unavailable and cannot coexist with source or attribute evidence.

The CLI replaces `--out` files atomically after a complete write, preserving the previous file if writing fails. Credential-like values are redacted before serialization and hashing; this does not guarantee detection of arbitrary unlabeled secrets.

Every manifest records provenance, a canonical `sourceHash`, `provenance.partial`, and warnings. The hash is SHA-256 over the redacted, schema-defaulted, validated document after sorting only order-insensitive collections; it uses JCS canonical JSON. `provenance.collectedAt`, `provenance.sourceHash`, and `provenance.collectionMetrics` are excluded, while content-order arrays such as `theme.settings` are preserved. `validate()` establishes schema validity and defaults, but does not attest the supplied source-hash integrity. Compare `sourceHash(context)` to `context.provenance.sourceHash` when integrity is required.

A present empty registry means it was read and empty; omitted evidence is never treated as empty. Warnings declare coverage as `complete`, `partial`, or `unavailable`; an undeclared warning is treated conservatively as partial. Strict collection requires complete blocks, bindings, and content-model evidence, including a surface explicitly read as empty.

`theme.settings` retains its collected constraints separately from native tokens. Its `settingsOrigin` is `merged` for WP-CLI (`core + blocks + theme + user`) and `theme` for REST (`core + blocks + theme`); neither setting evidence nor a legacy collection proves a native-token registry.

## Strictness and CLI exits

Non-strict collection can successfully write a partial manifest; inspect `provenance.partial` and warnings. `--strict` requires complete blocks, bindings, and content-model evidence. `validate` and `summarize` can exit 1 for actionable warnings even when the document is structurally valid.

| Status | Meaning |
| --- | --- |
| `0` | Operation completed; a non-strict collection can still be partial. |
| `1` | Strict policy failed, validation failed, or actionable warnings were found. |
| `2` | Usage or local-input error. |
| `3` | REST or WP-CLI transport/collection failure. |

## Portable consumer example

The package ships an executable [consumer helper example](examples/consumer-helpers.mjs) and its [synthetic fixture](examples/fixtures/consumer-manifest.json). It performs read-only native-reference lookups and compatibility checks, including their evidence, without changing WordPress content or inferring bindings. The fixture is manifest provenance (`collector: "fixture"`), not an executable collection transport. Its placeholder `sourceHash` is not an integrity assertion; load it with `validate`, never `collect`.

From a checkout:

```sh
npm run example:consumer-helpers
```

From an installed package directory:

```sh
node examples/consumer-helpers.mjs
```

## Consumer proof

Run `npm run example:consumer-proof` from a checkout to build and install the candidate in a clean consumer project, then compare fixed Block Runner inputs with no site tokens, full context and focused context. A separate Node example checks native references and field bindings through the installed Wesper API.

The comparison uses synthetic fixtures and the published `block-runner@0.8.0` package. It records emitted native references, retained intentional literals, validity and context size. See [the reproducible setup and its limits](https://github.com/humanmade/wesper/blob/main/docs/consumer-proof.md). The proof runner is repository tooling; Block Runner is not a Wesper runtime dependency.

## Versions and contribution

This guide describes Wesper 0.4.1, with collector semantics 0.2.3 and manifest `contextVersion: 1`. Version 0.4.1 adds package attribution, taxonomy records and collection fixes. Native-reference helpers require 0.0.3 or later; block relationships, MU-plugin inventory and post-type capabilities require 0.0.4 or later.

Wesper requires Node.js 20 or later, builds for Node 20, and CI checks Node 20 and 24. See [CONTRIBUTING.md](https://github.com/humanmade/wesper/blob/main/CONTRIBUTING.md) for setup and verification.

For the collection flow, source-file map and a worked field-change walkthrough, read [How Wesper works](https://github.com/humanmade/wesper/blob/main/docs/architecture.md).

The package version in `package.json` drives `wesper --version`. `COLLECTOR_VERSION` is separately versioned for shared WP-CLI/REST collection semantics and changes only when those semantics change. `contextVersion: 1` is the manifest compatibility version.

MCP, Abilities, ACF, diff/freshness, and WordPress mutations are outside the current delivery scope.

## License

GPL-2.0-or-later.
