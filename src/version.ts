import { createRequire } from 'node:module';

/** The published package version, shared by the library bundle and CLI. */
export const PACKAGE_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
