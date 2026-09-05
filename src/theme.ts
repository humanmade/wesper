import type { ContextWarning } from './types.js';

interface ThemeJsonSettings {
  color?: { palette?: PresetCollection<{ slug?: string; name?: string; color?: string }> };
  typography?: { fontFamilies?: PresetCollection<{ slug?: string; name?: string; fontFamily?: string }>; fontSizes?: PresetCollection<{ slug?: string; name?: string; size?: string; fluid?: unknown }> };
  spacing?: { spacingSizes?: PresetCollection<{ slug?: string; name?: string; size?: string }> };
}
type PresetCollection<T> = T[] | Record<string, T[]>;
export type ThemeTokenKind = 'color' | 'font-family' | 'font-size' | 'spacing';
export type ThemeTokenOrigin = 'core' | 'theme' | 'user' | 'unknown';
export type ThemeTokenValueSource = 'resolved' | 'declared';
export interface ThemeToken { id: string; kind: ThemeTokenKind; slug: string; label?: string; value: string; valueSource: ThemeTokenValueSource; origin: ThemeTokenOrigin; references: { cssCustomProperty: string; cssValue: string; blockStyle: string }; }
export interface NormalizedThemeTokens { presets: ThemeToken[]; colors: ThemeToken[]; fontFamilies: ThemeToken[]; fontSizes: ThemeToken[]; spacing: ThemeToken[]; }

/** Normalize effective presets. WordPress precedence is core < blocks < theme < user. */
export function parseThemeJsonSettings(settings: unknown, fontSizeValues?: unknown): NormalizedThemeTokens {
  const tokens: NormalizedThemeTokens = { presets: [], colors: [], fontFamilies: [], fontSizes: [], spacing: [] };
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return tokens;
  const typed = settings as ThemeJsonSettings;
  tokens.colors = effectiveTokens('color', presetEntries(typed.color?.palette), (entry) => entry.color);
  tokens.fontFamilies = effectiveTokens('font-family', presetEntries(typed.typography?.fontFamilies), (entry) => entry.fontFamily);
  tokens.fontSizes = effectiveTokens('font-size', presetEntries(typed.typography?.fontSizes, fontSizeValues), (entry, effectiveValue) => effectiveValue ?? entry.size, (_entry, effectiveValue) => effectiveValue !== undefined ? 'resolved' : 'declared');
  tokens.spacing = effectiveTokens('spacing', presetEntries(typed.spacing?.spacingSizes), (entry) => entry.size);
  tokens.presets = [...tokens.colors, ...tokens.fontFamilies, ...tokens.fontSizes, ...tokens.spacing].sort(byToken);
  return tokens;
}
export function themeWarnings(settings: unknown): ContextWarning[] {
  return !settings || typeof settings !== 'object' || Array.isArray(settings)
    ? [{ code: 'theme.settings_unavailable', severity: 'warning', surface: 'theme.settings', message: 'Theme settings could not be normalized.', coverage: 'partial' }]
    : [];
}
type PresetEntry<T> = { entry: T; origin: ThemeTokenOrigin; precedence: number; effectiveValue?: string };
function presetEntries<T>(collection: PresetCollection<T> | undefined, values?: unknown): PresetEntry<T>[] {
  if (Array.isArray(collection)) return collection.map((entry, index) => ({ entry, origin: 'unknown', precedence: 0, effectiveValue: arrayValue(values, index) }));
  if (!collection || typeof collection !== 'object') return [];
  return Object.entries(collection).flatMap(([bucket, entries]) => Array.isArray(entries)
    ? entries.map((entry, index) => ({ entry, ...originForBucket(bucket), effectiveValue: nestedArrayValue(values, bucket, index) }))
    : []);
}
function effectiveTokens<T extends { slug?: string; name?: string }>(kind: ThemeTokenKind, entries: PresetEntry<T>[], valueFor: (entry: T, effectiveValue?: string) => string | undefined, valueSourceFor: (entry: T, effectiveValue?: string) => ThemeTokenValueSource = () => 'declared'): ThemeToken[] {
  const winners = new Map<string, { token: ThemeToken; precedence: number }>();
  for (const { entry, origin, precedence, effectiveValue } of entries) {
    const value = valueFor(entry, effectiveValue);
    if (!entry.slug || !value) continue;
    const slug = normalizePresetSlug(entry.slug);
    if (!slug) continue;
    const candidate = makeToken(kind, slug, value, entry.name, origin, valueSourceFor(entry, effectiveValue));
    const current = winners.get(candidate.id);
    // Core's get_settings_values_by_slug() assigns each entry in source order,
    // so the final declaration at the same origin owns the native reference.
    if (!current || precedence >= current.precedence) {
      winners.set(candidate.id, { token: candidate, precedence });
    }
  }
  return [...winners.values()].map(({ token }) => token).sort(byToken);
}
function makeToken(kind: ThemeTokenKind, slug: string, value: string, label: string | undefined, origin: ThemeTokenOrigin, valueSource: ThemeTokenValueSource): ThemeToken {
  const cssCustomProperty = `--wp--preset--${kind}--${slug}`;
  return { id: `${kind}:${slug}`, kind, slug, ...(label ? { label } : {}), value, valueSource, origin, references: { cssCustomProperty, cssValue: `var(${cssCustomProperty})`, blockStyle: `var:preset|${kind}|${slug}` } };
}
function arrayValue(values: unknown, index: number): string | undefined { return Array.isArray(values) && typeof values[index] === 'string' ? values[index] : undefined; }
function nestedArrayValue(values: unknown, bucket: string, index: number): string | undefined {
  return values && typeof values === 'object' && !Array.isArray(values)
    ? arrayValue((values as Record<string, unknown>)[bucket], index)
    : undefined;
}

/** Exact port of WordPress `_wp_to_kebab_case()` for theme.json preset slugs. */
function normalizePresetSlug(slug: string): string {
  const lower = 'a-z\\u00df-\\u00f6\\u00f8-\\u00ff';
  const upper = 'A-Z\\u00c0-\\u00d6\\u00d8-\\u00de';
  const breaks = '\\u0000-\\u002f\\u003a-\\u0040\\u005b-\\u0060\\u007b-\\u00bf\\u2000-\\u206f \\t\\v\\f\\u00a0\\ufeff\\n\\r\\u2028\\u2029\\u1680\\u180e\\u202f\\u205f\\u3000';
  const lowerChar = `[${lower}]`;
  const upperChar = `[${upper}]`;
  const breakChar = `[${breaks}]`;
  const misc = `[^${breaks}\\d${lower}${upper}]`;
  const miscLower = `(?:${lowerChar}|${misc})`;
  const miscUpper = `(?:${upperChar}|${misc})`;
  const expression = new RegExp([
    `${upperChar}?${lowerChar}+(?=${breakChar}|${upperChar}|$)`,
    `${miscUpper}+(?=${breakChar}|${upperChar}${miscLower}|$)`,
    `${upperChar}?${miscLower}+`,
    `${upperChar}+`,
    '\\d*(?:1ST|2ND|3RD|(?![123])\\dTH)(?=\\b|[a-z_])',
    '\\d*(?:1st|2nd|3rd|(?![123])\\dth)(?=\\b|[A-Z_])',
    '\\d+',
  ].join('|'), 'gu');
  return (slug.replaceAll("'", '').match(expression) ?? []).join('-').toLowerCase();
}
function originForBucket(bucket: string): { origin: ThemeTokenOrigin; precedence: number } {
  switch (bucket) {
    case 'default': case 'core': return { origin: 'core', precedence: 1 };
    // WordPress exposes this as an intermediate merge bucket, but it is not a
    // supported token-origin label: retain its precedence without inventing one.
    case 'blocks': return { origin: 'unknown', precedence: 2 };
    case 'theme': return { origin: 'theme', precedence: 3 };
    case 'user': case 'custom': return { origin: 'user', precedence: 4 };
    default: return { origin: 'unknown', precedence: 0 };
  }
}
function byToken(left: ThemeToken, right: ThemeToken): number { return compareStrings(left.kind, right.kind) || compareStrings(left.slug, right.slug) || compareStrings(left.label ?? '', right.label ?? '') || compareStrings(left.value, right.value); }
function compareStrings(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
