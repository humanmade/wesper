import type { SiteContext } from './types.js';
import { redactSecrets } from './redact.js';

export function orderManifestForJson(context: SiteContext): SiteContext {
  // This function is also exported, so do not assume callers obtained their
  // context from collect() or validate().
  const redacted = redactSecrets(context);
  const { $schema, contextVersion, ...rest } = redacted;
  return { $schema, contextVersion, ...rest };
}

export function stringifyManifest(context: SiteContext): string {
  return `${JSON.stringify(orderManifestForJson(context), null, 2)}\n`;
}
