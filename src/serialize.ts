import type { SiteContext } from './types.js';

export function orderManifestForJson(context: SiteContext): SiteContext {
  const { $schema, contextVersion, ...rest } = context;
  return { $schema, contextVersion, ...rest };
}

export function stringifyManifest(context: SiteContext): string {
  return `${JSON.stringify(orderManifestForJson(context), null, 2)}\n`;
}
