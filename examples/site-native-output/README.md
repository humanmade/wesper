# Packaged Block Runner recorder

This is a bounded, synthetic acceptance recorder. It has no checked-in runs or findings: a result only exists after the supplied Block Runner package has run in a new temporary npm consumer.

The input is deliberately small and sanitised. It contains four values represented by the approved Wesper manifest's native preset registry and one intentional literal (`line-height: 1.4`), for which that registry has no token kind. It does not contact WordPress.

Build Wesper, make or obtain an explicit packaged Block Runner artifact, then choose a **new** result directory:

```sh
npm run build
npm run record:site-native-output -- \
  --block-runner /absolute/path/to/block-runner-0.9.0.tgz \
  --out /absolute/path/to/new-results-directory
```

The recorder packs this checkout of Wesper, installs that tarball and the exact supplied Block Runner tarball into a fresh temporary consumer, derives the focused projection with the installed Wesper public API, and invokes the installed `block-runner` binary three times:

- baseline: no `--context`;
- full: the shipped full manifest;
- focused: the installed Wesper `FocusedContext` projection.

It also executes the installed package's `independent-consumer.mjs`. That consumer imports only Wesper's public API (`validate`, `lookupNativeToken`, and `checkTokenReference`) and records its own token-reuse, invalid-reference, unnecessary-literal, repair-attempt, intentional-literal, duration, and unavailable-cost metrics against the same approved fixture.

Every result directory contains `record.json`, raw stdout/stderr and command metadata under `runs/`, plus `findings.json`. Provenance includes SHA-256 and byte size for both tarballs, installed package metadata, Node/npm versions, source hashes, exact argv, timings, and derived repair evidence. `findings.json` is derived from those raw files; it never supplies output, timing, or repair claims itself.

The focused arm intentionally fails as a recorded blocker if the packaged Block Runner CLI cannot consume `kind: "wesper.focused-context"`. That is a consumer capability gap, not a reason to silently substitute the full manifest or invent a focused result.

## Block Runner discovery replacement map

The recorder does not add a Block Runner-specific collection path to Wesper. The following map records the consumer seams it is intended to replace, based on Block Runner's source at the packaged-consumer handoff:

| Block Runner seam | Wesper boundary | What remains with Block Runner |
| --- | --- | --- |
| `token-resolver: wpcli` | `collect({ collector: 'wp-cli' })` returns the manifest and its native presets | selecting the resolver, caching, and applying tokens to conversion output |
| `token-resolver: rest` | `collect({ collector: 'rest' })` returns the manifest and its native presets | selecting credentials/resolver policy, caching, and applying tokens |
| `block-runner context` | `collect()` plus `stringifyManifest()` writes the portable manifest | CLI argument handling and output placement |
| `--context site.context.json` | `validate()` reads a full manifest; `focusContext()` produces the smaller task view | converting the selected token values and block capabilities into its own output rules |

The focused view is intentionally not a `SiteContext`, so a consumer must recognize `kind: "wesper.focused-context"` before it adapts the view's `blocks` and `tokens`. A package that accepts only full manifests is recorded as blocked by the focused arm. Neither the fixture nor the recorder establishes that any representative WordPress site has the same settings, support matrix, latency, or output quality.

The recorder leaves its temporary consumer in place and records its path, so a failed run remains inspectable. Remove it manually when no longer needed.
