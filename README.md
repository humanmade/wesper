# Wesper

**The primitive that reads what a WordPress site can accept.**

[![license](https://img.shields.io/github/license/humanmade/wesper.svg)](./LICENSE)

> Status: early scaffold. The manifest schema and the WP-CLI collector are the first build (see milestones in the spec). The shape below is the target.

Agents and tools generate content for WordPress, but they generate it *blind* — inventing
block attributes, binding to meta keys that do not exist, ignoring the theme's tokens,
emitting blocks the site cannot render, and overclaiming portability. Wesper reads a
WordPress site and emits one portable, provenanced **context manifest** that answers a single
question:

> What can this specific WordPress site safely accept, reference, and bind to?

It captures the block registry, theme tokens, **Block Bindings sources and fields**, post
types, patterns, media rules, and the capability surface — normalized into one
`site.context.json`, with provenance and freshness, and every gap recorded as a warning
rather than a guess. Deliberately a primitive rather than a platform: it reads, it does not
write, and it ships native data nothing proprietary has to stay installed to read.

```sh
# read a site into a manifest (local WP-CLI)
wesper collect --wp-path ./public --out site.context.json

# then feed it to a consumer — e.g. Block Runner's binding pass
block-runner convert hero.html --bind --context site.context.json
```

## Why it exists

It is the read half of the agentic-WordPress loop: **read the site (wesper) → author native
blocks ([block-runner](https://github.com/humanmade/block-runner)) → wire them to the site's
real data (the binding pass).** Block Runner already reaches into WordPress for theme tokens
via a built-in resolver; Wesper is that pattern lifted out, widened to the whole world model
(binding sources, fields, registry, patterns, abilities), and made a reusable artifact every
consumer can share — instead of each agent re-deriving brittle introspection of its own.

## What it does

- **One normalized manifest.** A stable, versioned `site.context.json` schema, so every
  consumer reads one known shape instead of hand-rolling `wp eval` scrapes.
- **A transport ladder, not one method.** Collect via WP-CLI (local/SSH), authenticated
  REST/Abilities/MCP (no-shell hosts), or a hand-authored fixture (tests/CI). The schema is
  independent of how it was gathered.
- **Binding-ready.** Surfaces registered Block Bindings sources, their argument schemas, and
  the fields/meta keys reachable per post type — the slice the binding pass cannot function
  without.
- **Provenance + freshness.** Every manifest is stamped (`collectedAt`, collector, source
  hash, TTL) so consumers can detect stale context and diff it in CI.
- **Honest about gaps.** A thin manifest is allowed, but it must say *where* it is thin.
  Warnings are first-class output; absent data is never invented.
- **Untrusted by contract.** Consumers validate the manifest against the schema and never
  eval anything from it. Wesper reads; it does not register sources, create fields, or run a
  service.

## CLI (target)

```sh
wesper collect --wp-path <path> --out site.context.json   # local WP-CLI
wesper collect --url <url> --auth <profile> --out site.context.json   # remote REST/Abilities/MCP
wesper validate site.context.json
wesper summarize site.context.json
wesper diff old.context.json new.context.json
```

## License

GPL-2.0-or-later.
