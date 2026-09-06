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

## Consumer and WordPress checks

`npm run example:consumer-proof` builds and packs this checkout, installs the tarball and pinned Block Runner package into a temporary consumer project, and records the comparison under ignored `build/consumer-proof/`. It needs npm registry access but no site or model credentials. See [consumer proof](docs/consumer-proof.md) for the assertions, outputs and interpretation.

The collector conformance suite provisions a disposable synthetic WordPress site with Docker:

```sh
WORDPRESS_VERSION=6.5.5 npm run test:integration
WORDPRESS_VERSION=7.1.0 npm run test:integration
```

Run these sequentially when using the default port. The runner creates its own Compose project and checks that collection leaves the fixture's content, meta and registrations unchanged. CI pairs WordPress 6.5.5 with Node 20 and WordPress 7.1.0 with Node 24.
