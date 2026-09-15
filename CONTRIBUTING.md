# Contributing

Use Node.js 20 or later. Wesper targets Node 20, and CI runs the package checks on Node 20 and 24.

```sh
npm ci
npm run verify
```

`npm run verify` covers type checking, unit tests, the build, and installed-package checks. Consumer proof and Docker-based WordPress checks run separately.

For the collection flow, source-file map and a worked field-change walkthrough, read [How Wesper works](docs/architecture.md).

Version sources are deliberately separate:

- `package.json` is the package version, used by `wesper --version`; it is not necessarily the version currently published to npm.
- `COLLECTOR_VERSION` in `src/collector/normalize.ts` identifies the shared WP-CLI/REST collection semantics. Bump it intentionally when those semantics change.
- `contextVersion` is the manifest compatibility version. Version `1` identifies the V1 document contract.

`npm run clean` moves `dist/` to the system Trash (with a `~/.Trash/` fallback when the `trash` command is unavailable). Restore a build by moving it back to `dist/`. Older archives under ignored `.trash/` are left intact.

## Consumer and WordPress checks

`npm run example:consumer-proof` builds and packs this checkout, installs the tarball and pinned Block Runner package into a temporary consumer project, and records the comparison under ignored `build/consumer-proof/`. It needs npm registry access but no site or model credentials. See [consumer proof](https://github.com/humanmade/wesper/blob/main/docs/consumer-proof.md) for the assertions, outputs and interpretation.

The collector conformance suite provisions a disposable synthetic WordPress site with Docker:

```sh
WORDPRESS_VERSION=6.5.5 npm run test:integration
WORDPRESS_VERSION=7.1.0 npm run test:integration
```

Run these sequentially when using the default port. The runner creates its own Compose project and checks that collection leaves the fixture's content, meta and registrations unchanged. CI pairs WordPress 6.5.5 with Node 20 and WordPress 7.1.0 with Node 24.

## Keep verification focused

The unit suite is small enough to run in full during normal development. Use a single test file when iterating on a specific failure, then run `npm run verify` before handing off a behavior change:

```sh
npm test -- src/collector/rest.test.ts
npm run verify
```

Choose the additional proof from the behavior that changed:

| Change | Additional check |
|---|---|
| WP-CLI/PHP collection, REST mapping, normalization, or manifest schema | Run the disposable WordPress suite against both supported versions above. Check collected values and unavailable evidence, not just whether a manifest parses. |
| Native tokens, references, focus/compatibility helpers, or packaged consumer API | Run `npm run example:consumer-proof`. Compare full and focused output and preserve intentional literals. |
| Credential handling, hashing, output files, or collection limits | Keep a regression for the actual leak, data-loss, or failure case. Run the relevant direct proof as well as `npm run verify`. |
| Workflow configuration | Validate YAML and event conditions locally; report hosted behavior only after a matching Actions run. |
| Prose only | Check links and commands against their current definitions; a local application rebuild adds little evidence. |

CI continues to run the complete package and WordPress matrices. A new commit on a PR cancels that PR's obsolete check run; separate PRs and pushes to `main` keep independent runs. Release publishing is a separate workflow. No tests are selected or skipped by changed-file heuristics.

When investigating slow feedback, inspect Actions job and step durations first. Unit-test selection, a new build tool, or another CI service needs a measured bottleneck to justify its maintenance cost. Keep changes in small commits that can be reviewed and reverted independently, and record which checks actually ran.
