# Reproduce native-reference consumption

This comparison feeds a validated Wesper manifest into two consumers. It checks whether known site tokens produce native WordPress output, and whether selecting less context preserves the result for the same task.

## Run

Use Node.js 20 or later and npm registry access:

```sh
npm ci
npm run example:consumer-proof
```

The command builds this checkout, packs it, installs the tarball together with `block-runner@0.8.0` in a temporary consumer project, and invokes the installed public APIs. It does not load Wesper source files into the consumer or use a sibling Block Runner checkout. It uses synthetic data and makes no WordPress or model requests.

The printed result identifies `build/consumer-proof/<run-id>/evidence.json`. Each run retains its candidate tarball, manifest, consumer result, canonicalisation receipts and baseline/full/focused output. The tarball checksum identifies the tested bytes; the source commit and dirty flag distinguish a committed build from a working-tree candidate. Generated artifacts are ignored by Git.

## Fixed comparison

The fixture declares a `primary` colour, `body` font family, `large` font size and `40` spacing preset. Each has a kind, slug, effective value and native reference forms. A deliberately unmatched colour represents an intentional literal.

The Block Runner adapter maps the manifest's preset kinds into its public token configuration:

| Wesper token kind | Block Runner configuration |
| --- | --- |
| `color` | `colors[slug] = value` |
| `font-family` | `fonts[slug] = value` |
| `font-size` | `fontSizes[slug] = value` |
| `spacing` | `spacing[slug] = value` |

The same input is processed without site tokens, with the full manifest's tokens, and with tokens selected by `focusContext`. Matching values must become native preset references and the unmatched literal must remain. Outputs must remain valid according to Block Runner, and the full/focused outputs must agree. Byte counts describe the context supplied, not a measured reduction in model tokens or generation cost.

The independent Node consumer imports Wesper's lookup and compatibility helpers. It checks a known token, an explicit `core/paragraph` content binding to the fixture's `core/post-meta` field, a missing token in a complete registry, and a missing native registry. These must return compatible, incompatible or unknown according to the collected evidence. The field's binding arguments are preserved verbatim.

The V1 block `source` field is a legacy namespace classification, not ownership
provenance: `core` means a `core/*` block name and `plugin` means any other block
name. A `plugin` value must not be used to infer that the implementation belongs
to a plugin; it may be supplied by a theme, MU plugin, shared package, or another
source. Since 0.0.4, collectors report overlapping block relationships and context
declarations as `parent`, `ancestor`, `allowedBlocks`, `usesContext`, and
`providesContext`. These optional fields may be absent in older manifests or
unavailable through a transport; missing declarations do not establish unrestricted
placement. Registry declarations alone do not prove editor or front-end behavior.

Version 0.4.1 adds separate package attribution and taxonomy records; see [the ownership contract](../README.md#package-attribution-and-taxonomies). Block metadata matches and observed registration callers are different evidence. This native-reference fixture comparison does not by itself verify either attribution mechanism.

The fixture's placeholder hash is replaced with a hash of its validated document for this controlled comparison. That is fixture preparation, not a recommendation to overwrite a supplied manifest's hash when checking integrity.

## What this replaces

The adapter reads the collected preset registry instead of issuing WordPress discovery requests or parsing `theme.settings` again. The independent consumer uses reported references and field arguments instead of reconstructing preset strings or guessing source-specific argument keys.

No discovery code is deleted from Block Runner by this example. The pinned Block Runner 0.8.0 `--context` resolver reads `theme.settings`; it is not the entry point used here. The explicit public configuration adapter demonstrates consumption of Wesper's native preset list without claiming the built-in resolver has been migrated.

## Interpretation and limits

This is a deterministic conversion comparison on synthetic data. It establishes native-reference reuse for the demonstrated cases and package interoperability, not improved LLM generation, runtime rendering on an arbitrary site, a performance benchmark or independent third-party adoption. Model and cost metrics are not measured.

The timings cover a single sequential pass. The first baseline call also pays Block Runner's initialisation cost, so the recorded times must not be used to claim that full or focused context makes conversion faster.

A focused context is a derived view, not a `SiteContext` manifest. The adapter reads its selected tokens; it does not pass that view into manifest validation or a manifest-only CLI option.

For a live site, transport coverage still matters. WP-CLI can report merged user theme settings and registered binding evidence. Core REST collection is partial: it lacks binding-source and registered-meta evidence, excludes user theme customisations and cannot satisfy strict collection. A missing capability in partial evidence remains unknown.

## 0.4.1 implementation verification

[Commit `ddf9b98` passed CI](https://github.com/humanmade/wesper/actions/runs/34918382064) with 186 tests and package checks on Node 20/24, the native consumer proof on Node 24, and real WordPress 6.5.5/7.1.0 conformance. The integration fixture checks post-type and taxonomy ownership, associations, deterministic hashes and unchanged synthetic content/meta/registrations. Focused PHP tests cover wrappers, themes, single-file MU plugins, symlinked theme roots, replacement registrations, ambiguous callers and truncated traces.

Version 0.4.1 uses collector semantics 0.2.3 and includes these additions. This evidence establishes the tested collector and consumer contracts. Agent time savings, downstream visualization behavior and general browser behavior remain unverified here.

## Historical release verification (0.0.4)

[Wesper 0.0.4 passed CI](https://github.com/humanmade/wesper/actions/runs/34452764511) at commit `bb0466740898ba4b7d837251b497b6073a518232`: 150 unit tests and package checks on Node 20/24, this consumer proof on Node 24, and separate collector conformance on WordPress 6.5.5/7.1.0. The collector fixtures remained unchanged. This establishes package interoperability and synthetic collector conformance, not arbitrary-site rendering or adoption.

## Historical recorded result (0.0.3)

A local run on 6 September 2026 used the Wesper 0.0.3 candidate, Node 24.18.0 and published Block Runner 0.8.0:

| Check | Baseline | Full context | Focused context |
| --- | --- | --- | --- |
| Demonstrated native token references | 0 | 4 | 4 |
| Invalid blocks reported | 0 | 0 | 0 |
| Deliberately unmatched colour | Retained | Retained | Retained |
| Full/focused output | — | Identical | Identical |
| Serialised context size | — | 2,780 bytes | 2,050 bytes |

The focused view was 730 bytes smaller for this fixture. The independent consumer returned compatible for the known token/binding, incompatible for an absent token on complete evidence, and unknown for the missing native registry. These are fixture results; rerun the command against a later candidate instead of treating them as a general benchmark.

The [merged 0.0.3 candidate passed CI](https://github.com/humanmade/wesper/actions/runs/34023227537), including this proof on Node 24 and package verification on Node 20 and 24. The CI package job retains consumer-proof artifacts for 14 days. The independent Wesper consumer is also exercised by package verification on both Node versions.
