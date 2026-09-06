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

Every result directory contains `record.json`, raw stdout/stderr and command metadata under `runs/`, plus `findings.json`. Provenance includes SHA-256 and byte size for both tarballs, installed package metadata, Node/npm versions, source hashes, exact argv, timings, and derived repair evidence. `findings.json` is derived from those raw files; it never supplies output, timing, or repair claims itself.

The focused arm intentionally fails as a recorded blocker if the packaged Block Runner CLI cannot consume `kind: "wesper.focused-context"`. That is a consumer capability gap, not a reason to silently substitute the full manifest or invent a focused result.

The recorder leaves its temporary consumer in place and records its path, so a failed run remains inspectable. Remove it manually when no longer needed.
