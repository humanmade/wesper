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

## Why it exists

It is the read half of the agentic-WordPress loop: **read the site (wesper) → author native
blocks ([block-runner](https://github.com/humanmade/block-runner)) → wire them to the site's
real data (the binding pass).** Block Runner already reaches into WordPress for theme tokens
via a built-in resolver; Wesper is that pattern lifted out, widened to the whole world model
(binding sources, fields, registry, patterns, media), and made a reusable artifact every
consumer can share — instead of each agent re-deriving brittle introspection of its own.

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

## License

GPL-2.0-or-later.
