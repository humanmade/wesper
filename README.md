# Wesper

Wesper is a read-only dependency for discovering what a WordPress site can safely accept, reference, and bind to. It produces a portable, provenanced context manifest for native WordPress consumers.

```sh
npm install wesper
```

Use it from a library first:

```ts
import { collect, lookupNativeToken, summarize, validate } from 'wesper';

const collected = await collect({ collector: 'wp-cli', wpPath: './public' });
const checked = validate(collected);
if (!checked.ok || !checked.context) throw new Error('Invalid manifest');
console.log(summarize(checked.context));

const primary = lookupNativeToken(checked.context, { kind: 'color', slug: 'primary' });
if (primary.status === 'found') console.log(primary.value.references.blockStyle);
```

Or install the CLI globally:

```sh
npm install --global wesper
wesper collect --wp-path ./public --out site.context.json
wesper validate site.context.json
wesper summarize site.context.json
```

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

WP-CLI produces merged theme settings and can collect registered Block Bindings sources and registered post meta.

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

`timeoutMs`, `restConcurrency`, `maxResponseBytes`, and `AbortSignal` are available to library callers; corresponding REST CLI flags are available for the numeric limits.

## Native references and coverage

Native theme tokens include stable `id`, kind, slug, value, origin, and `references`: `cssCustomProperty`, `cssValue`, and `blockStyle`. For example, a colour token can produce `var:preset|color|primary` directly for a block style value. Wesper does not infer semantic roles from token names. Native-token coverage is distinct from theme-settings coverage: `theme.tokens.presets: []` proves an empty native registry, while settings-only and legacy token collections do not.

`lookupNativeToken`, `lookupBlock`, and `lookupField` perform exact token kind/slug, block name, and field key-or-name matches. They return `found`, `absent` only for complete evidence, or `unknown` for partial/unavailable evidence. A field lookup can additionally qualify its source. Field lookups preserve their reported `args` exactly; consumers should copy those binding arguments verbatim rather than inferring source-specific keys.

`focusContext` creates a deterministic narrowed view for explicitly selected post types, blocks, and token kinds. Omitted or empty selectors select nothing. Its `sourceManifestHash` identifies the parent manifest only; it is not a hash of the projection.

### Compatibility checks

`checkTokenReference` checks an explicit native-token `kind` and `slug`; `checkBindingReference` checks an explicit block, attribute, source, and field selector. Each returns `compatible`, `incompatible`, or `unknown`, with deterministic reasons, stable manifest identifiers, relevant warnings and coverage, plus the manifest `sourceManifestHash` behind the conclusion. Missing or partial evidence is conservatively `unknown`; only complete evidence can establish an absence.

Binding prerequisites are checked independently: the block, supported attribute, source, and exact source-qualified field must each be supported. Compatible field and source `args` are returned verbatim, never inferred or rewritten. These checks concern manifest compatibility only—not runtime rendering, permissions, post context, or semantic/design choices. They do not diagnose literals or propose replacements; a consumer that adds an opt-in literal suggestion must present its supporting evidence rather than treating every literal as wrong.

### Binding join

Before writing `metadata.bindings`, consumers join `bindings.supportedAttributes` (the bindable attributes reported for each block type) with `contentModel.postTypes[].fields` (the fields reported for the target post type). Each field carries ready-to-use `args`; copy them verbatim. In particular, do not invent `field` for `core/post-data` or `key` for `core/post-meta`—Wesper owns that source-specific syntax.

The field's source must be one of the reported `bindings.sources`; `bindings.available: false` means that binding evidence was explicitly unavailable and cannot coexist with source or attribute evidence.

Every manifest records provenance, a canonical `sourceHash`, `provenance.partial`, and warnings. The hash is SHA-256 over the redacted, schema-defaulted, validated document after sorting only order-insensitive collections; it uses JCS canonical JSON. `collectedAt` and `sourceHash` itself are excluded, while content-order arrays such as `theme.settings` are preserved. `validate()` establishes schema validity and defaults, but does not attest the supplied source-hash integrity. Compare `sourceHash(context)` to `context.provenance.sourceHash` when integrity is required.

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

The comparison uses synthetic fixtures and the published `block-runner@0.8.0` package. It records emitted native references, retained intentional literals, validity and context size. See [the reproducible setup and its limits](docs/consumer-proof.md). The proof runner is repository tooling; Block Runner is not a Wesper runtime dependency.

## Versions and contribution

Wesper requires Node.js 20 or later, builds for Node 20, and CI checks Node 20 and 24. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and verification.

The package version in `package.json` drives `wesper --version`. `COLLECTOR_VERSION` is separately versioned for shared WP-CLI/REST collection semantics and changes only when those semantics change. `contextVersion: 1` is the manifest compatibility version.

MCP, Abilities, ACF, diff/freshness, and WordPress mutations are outside the current delivery scope.

## License

GPL-2.0-or-later.
