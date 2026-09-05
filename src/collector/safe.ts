const REDACTED = '[REDACTED]';
const REDACTED_URL = '[REDACTED_URL]';

// Error messages often contain the argv used by a subprocess or a request dump.
// Treat a URL with userinfo as an atomic secret: retaining its host is not useful
// enough to justify risking a password embedded in an unusual URL encoding.
const URL_WITH_USERINFO = /(?:(?:\b[a-z][a-z\d+.-]*:)?\/\/)[^\s/?#@]+@[^\s'"`<>\])},]*/gi;
const URL_WITH_USERINFO_TEST = /(?:(?:\b[a-z][a-z\d+.-]*:)?\/\/)[^\s/?#@]+@[^\s'"`<>\])},]*/i;
const AUTHORIZATION_HEADER = /\b((?:proxy-)?authorization)\b(?:"|')?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,}\]]+)/gi;
// WordPress displays Application Passwords in space-separated groups. Handle
// those labels before generic passwords so all groups are removed together.
const LABELLED_APP_PASSWORD = /\b((?:wp[_-]?api[_-]?password|wp[_-]?app[_-]?password|application[-_ ]?password|app[-_ ]?password))\b(?:"|')?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+(?:[ \t]+[^\s,;}\]]+)*)/gi;
const LABELLED_SECRET = /\b((?:password|passwd|passphrase))\b(?:"|')?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/gi;
const COMMAND_CREDENTIAL = /(^|\s)((?:-u|--?(?:user|password|passwd|pwd)|--(?:app[-_]?password|application[-_]?password)))(?:=|\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/gi;

/**
 * Makes a diagnostic safe to write to stderr. This is deliberately limited to
 * credentials that can appear in collector command and HTTP diagnostics; it is
 * not a general-purpose secret scanner.
 */
export function sanitizeErrorMessage(error: unknown): string {
  // Do not invoke arbitrary `toString()` implementations while handling an
  // error; a collector can reject with any value and that conversion itself
  // could disclose input or throw.
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : 'Unknown collector error.';
  return text
    .replace(URL_WITH_USERINFO, REDACTED_URL)
    .replace(AUTHORIZATION_HEADER, '$1: [REDACTED]')
    .replace(LABELLED_APP_PASSWORD, '$1: [REDACTED]')
    .replace(LABELLED_SECRET, '$1: [REDACTED]')
    .replace(COMMAND_CREDENTIAL, `$1$2=${REDACTED}`);
}

/** Reject URLs whose userinfo could otherwise enter subprocess argv or manifests. */
export function assertNoUrlCredentials(value: string, optionName: string): void {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      throw new Error(`${optionName} must not contain URL credentials.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message === `${optionName} must not contain URL credentials.`) {
      throw error;
    }

    // An invalid URL will be rejected by the collector's normal validation, but
    // still reject an embedded userinfo-shaped value before it can be logged.
    if (URL_WITH_USERINFO_TEST.test(value)) {
      throw new Error(`${optionName} must not contain URL credentials.`);
    }
  }
}
