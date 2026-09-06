# Contributing

Use Node.js 20 or later. Wesper targets Node 20, and CI runs the package checks on Node 20 and 24.

```sh
npm ci
npm run verify
```

Version sources are deliberately separate:

- `package.json` is the published package version, used by `wesper --version`.
- `COLLECTOR_VERSION` in `src/collector/normalize.ts` identifies the shared WP-CLI/REST collection semantics. Bump it intentionally when those semantics change.
- `contextVersion` is the manifest compatibility version. Version `1` identifies the V1 document contract.

`npm run clean` archives `dist/` under ignored `.trash/` rather than deleting it. Restore a build by moving the archived directory back to `dist/`.

## Packaged consumer recording

`examples/site-native-output/` contains an approved synthetic input and a recorder, not checked-in benchmark results. Run it only with an explicit Block Runner `.tgz` and a new output directory; the recorder installs both packages into a fresh temporary consumer and writes the resulting raw CLI evidence there.
