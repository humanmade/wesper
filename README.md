# Wesper

**The primitive that reads what a WordPress site can accept.**

[![license](https://img.shields.io/github/license/humanmade/wesper.svg)](./LICENSE)

> Status: V1 scaffold. The manifest schema, WP-CLI and REST collectors, validation, and summary surfaces are the first build.

Agents and tools generate content for WordPress, but they generate it *blind* — inventing
block attributes, binding to meta keys that do not exist, ignoring the theme's tokens,
emitting blocks the site cannot render, and overclaiming portability. Wesper reads a
WordPress site and emits one portable, provenanced **context manifest** that answers a single
question:

> What can this specific WordPress site safely accept, reference, and bind to?

It captures the block registry, theme tokens, **Block Bindings sources and fields**, post
types, patterns, media rules, and the capability surface — normalized into one
`site.context.json`, with provenance and a content hash, and every gap recorded as a warning
rather than a guess. Deliberately a primitive rather than a platform: it reads, it does not
write, and it ships native data nothing proprietary has to stay installed to read.

```sh
# read a site into a manifest (local WP-CLI)
wesper collect --wp-path ./public --out site.context.json

# then feed it to a consumer — e.g. Block Runner's binding pass
block-runner convert hero.html --bind --context site.context.json
```

## Install

```sh
npm install --global wesper
```

## Supported versions and conformance checks

Wesper supports Node.js 20 or later. Pull requests exercise the minimum supported
Node line (20) and the current Node LTS line (24). The package is built for Node 20.

The WordPress collector supports WordPress 6.5 or later. Its conformance matrix uses
WordPress 6.5.5, on the first Block Bindings release line, and 7.1.0, a later core
API boundary. These are deliberately pinned tested boundaries so a pull request
has reproducible evidence; update the upper boundary intentionally when
WordPress core changes.

Run the fast repository checks locally with:

```sh
npm run verify
```

The integration suite provisions a disposable WordPress install and only uses its
sanitised fixture content. It invokes both the real WP-CLI PHP collector and the core
REST API with permitted and denied access, then compares the documented equivalent
surfaces and checks a controlled synthetic pattern in both transports. It also verifies
theme and user overrides, token-kind collisions, registered and protected meta, absent
sources, registered patterns, deterministic hashes, coverage,
and native references. No production site or credentials are used.

Docker and Node.js are required to run it locally. Select a matrix version when needed:

```sh
WORDPRESS_VERSION=6.5.5 npm run test:integration
WORDPRESS_VERSION=7.1.0 npm run test:integration
```

Fixture setup can create its disposable database, site, and test registrations. The
collector itself remains read-only: it does not write site content, fields, or binding
sources.

## Why it exists

It is the read half of the agentic-WordPress loop: **read the site (wesper) → author native
blocks ([block-runner](https://github.com/humanmade/block-runner)) → wire them to the site's
real data (the binding pass).** Block Runner already reaches into WordPress for theme tokens
via a built-in resolver; Wesper is that pattern lifted out, widened to the whole world model
(binding sources, fields, registry, patterns, media), and made a reusable artifact every
consumer can share — instead of each agent re-deriving brittle introspection of its own.

## Theme token contract

`theme.tokens.presets` is the consumer-facing effective preset list. Each token has a stable
`id` (`<kind>:<slug>`), `kind`, WordPress `slug`, declared `label` when supplied, `value`,
`valueSource`, and `origin`. Kinds are `color`, `font-family`, `font-size`, and `spacing`; font
families and sizes are also available separately in `fontFamilies` and `fontSizes`. The legacy
mixed `typography` array remains readable for V1 manifests but collectors do not emit it.

Every collected token includes native forms in `references`: `cssCustomProperty` (for example
`--wp--preset--color--primary`), `cssValue` (`var(--wp--preset--color--primary)`), and
`blockStyle` (`var:preset|color|primary`). A consumer can use `blockStyle` directly in a block
style attribute; it does not need to recreate WordPress preset syntax. Wesper never infers roles
such as “primary” from a slug or value.

`theme.settings` retains the collected settings and their constraints (for example custom colour,
typography, spacing, layout, and unit controls). Its `settingsOrigin` is the exact layer read:
`merged` for WP-CLI (`core + blocks + theme + user`) and `theme` for REST global styles
(`core + blocks + theme`). A
font-size token’s `valueSource` is `resolved` when WP-CLI asked WordPress for the CSS custom
property value (including fluid `clamp(...)` values); otherwise it is `declared`. Missing
settings leave the theme evidence absent; they are not represented as a known empty token set.
Within origin buckets Wesper resolves a duplicate kind/slug using WordPress precedence:
`core < blocks < theme < user`. Buckets without a supported public origin label (including
intermediate block settings) are reported as `origin: "unknown"`; Wesper never invents one.

## What it does

- **One normalized manifest.** A stable, versioned `site.context.json` schema, so every
  consumer reads one known shape instead of hand-rolling `wp eval` scrapes.
- **A transport ladder, not one method.** V1 collects via WP-CLI (local/SSH), the REST API
  (Application Password over core WordPress endpoints), or a hand-authored fixture (tests/CI).
  The REST collector is vendor-neutral — core endpoints only, no consumer-specific logic in core.
  The schema is independent of how it was gathered.
- **Binding-ready.** Surfaces registered Block Bindings sources and per-post-type fields with
  ready-to-use binding `args`, so consumers do not need source-specific argument logic.
- **Provenance + content hash.** Every manifest is stamped (`collectedAt`, collector,
  `sourceHash`) so consumers can compare logical staleness by content, not guess from wall-clock
  age.
- **Honest about gaps.** A thin manifest is allowed, but it must say *where* it is thin.
  Warnings are first-class output; absent data is never invented. Present-empty means the surface
  was read and empty; absent means it could not be read and must have a warning.
- **Untrusted by contract.** Consumers validate the manifest against the schema and never
  eval anything from it. Wesper reads; it does not register sources, create fields, or run a
  service.

### Input and credential safety

Wesper treats collector data and manifests as untrusted input. Credential-like dictionary
keys are redacted, and URL userinfo is rejected for collector options or sanitised before a
manifest is hashed or serialised. Collector diagnostics redact Authorization headers and
credential-bearing command values before they reach stderr.

Traversal is bounded to 64 nested containers and 100,000 object members or array slots.
`validate()` turns input that exceeds those limits (or has a cycle or accessor) into an
`ok: false` result with a value-free error; `redactSecrets()` and canonicalization throw the
exported `RedactionError` for the same condition. This prevents malformed input from causing
uncontrolled recursion while retaining ordinary schema fields and design-token metadata.

## Hash and validation contract

`provenance.sourceHash` is the SHA-256 fingerprint of the final collected document. Before it is
calculated, Wesper redacts credential-shaped values, applies schema defaults, validates the
document, and sorts only collections whose order has no meaning (such as plugins, block types,
and registered image sizes). `collectedAt` and `sourceHash` itself are excluded. Arrays whose
order is content, including `theme.settings` arrays, are preserved. Canonical JSON is RFC 8785
(JCS, UTF-8): object names are ordered by UTF-16 code units and finite JSON numbers use the
ECMAScript JSON representation.

`validate()` and `wesper validate` establish **schema validity**, redact returned data, and apply
schema defaults. They deliberately do **not** establish **hash integrity**: a structurally valid
manifest may contain a stale or altered `provenance.sourceHash`. Consumers that require integrity
must make the explicit comparison after validation:

```ts
const result = validate(manifest);
const hasIntegrity = Boolean(
  result.ok && result.context && sourceHash(result.context) === result.context.provenance.sourceHash,
);
```

Collector builds that predate this contract hashed before defaults were materialized. Re-collect
those manifests (or validate them and recompute the fingerprint) before using their source hash
as an integrity assertion. The hash continues to represent redacted manifest content with the
same volatile provenance fields excluded.

## V1 compatibility contract

V1 is forward-compatible for additive JSON properties: producers may preserve extension
properties and consumers must ignore properties they do not understand. The named V1 registry
records are not extension bags, however. Plugins require `slug`, `name`, and `active`; block
types require their identifier, attributes, supports, and source; image sizes require their
identifier and dimensions; and each field must explicitly declare `bindable`.

Validation also enforces V1 relationships that JSON Schema cannot represent: registry identifiers
must be unique, bindable fields must reference a reported binding source, core source arguments
must use their documented `field` or `key` argument, and `bindings.available: false` cannot
coexist with binding evidence. These checks return path-specific, machine-readable validation
issues. A change that requires a consumer to reinterpret an existing known V1 field requires a
new `contextVersion`, rather than silently changing V1 semantics.

## Consumer contract: the binding join

Binding consumers join two manifest slices before writing `metadata.bindings`:

- `bindings.supportedAttributes` tells the consumer which attributes on each block type can be
  bound on this WordPress install.
- `contentModel.postTypes[].fields` tells the consumer which fields exist for the target post type.
  Each field carries a ready-to-use `args` object.

When a supported block attribute is matched to a field, copy `field.args` verbatim into the binding.
Consumers must not infer source-specific argument names such as `field` for `core/post-data` or
`key` for `core/post-meta`; Wesper owns that syntax.

## CLI (target)

```sh
wesper collect --wp-path <path> --out site.context.json   # local WP-CLI
wesper collect --ssh <target> --wp-path <path> --out site.context.json
wesper collect --rest --wp-url <site-root> --wp-user <user> --out site.context.json   # REST (App Password via WP_API_PASSWORD)
wesper validate site.context.json
wesper summarize site.context.json
```

REST collection accepts `--timeout-ms`, `--rest-concurrency`, and
`--max-response-bytes` to bound end-to-end execution, parallel requests, and
individual response payloads. Library callers can pass the corresponding
`CollectOptions` fields and an `AbortSignal`.

### Exit status

`collect` may successfully produce a partial manifest unless `--strict` is set; inspect
`provenance.partial` and the warnings when using its output. The CLI uses these status codes
consistently:

| Status | Meaning |
| --- | --- |
| `0` | The requested operation completed. A non-strict collection may still be partial. |
| `1` | Strict collection policy rejected incomplete evidence, or manifest validation found invalid or actionable evidence. |
| `2` | Command usage or local input error (for example incompatible options, an unreadable manifest, or an unsupported summary format). |
| `3` | The collector could not communicate with or execute its source transport (REST or WP-CLI). |

Strict collection requires complete block-type, binding, and content-model evidence—the
minimum needed to safely construct bindings. `complete` includes a source that was read and
found empty; `partial` and `unavailable` never satisfy that policy, even when their explanatory
warning is informational. Warnings may declare their coverage as `complete`, `partial`, or
`unavailable`; an undeclared warning is conservatively treated as partial evidence.

For programmatic collection, the library exposes the corresponding error codes:
`WESPER_STRICT_POLICY`, `WESPER_USAGE`, and `WESPER_TRANSPORT`.

## License

GPL-2.0-or-later.
