import type { ContextWarning } from './types.js';

interface ThemeJsonSettings {
  color?: { palette?: PresetCollection<{ slug?: string; name?: string; color?: string }> };
  typography?: { fontFamilies?: PresetCollection<{ slug?: string; name?: string; fontFamily?: string }>; fontSizes?: PresetCollection<{ slug?: string; name?: string; size?: string }> };
  spacing?: { spacingSizes?: PresetCollection<{ slug?: string; name?: string; size?: string }> };
}
type PresetCollection<T> = T[] | Record<string, T[]>;
export type ThemeTokenKind = 'color' | 'font-family' | 'font-size' | 'spacing';
export type ThemeTokenOrigin = 'core' | 'theme' | 'user' | 'unknown';
export interface ThemeToken { id: string; kind: ThemeTokenKind; slug: string; label?: string; value: string; origin: ThemeTokenOrigin; references: { cssCustomProperty: string; cssValue: string; blockStyle: string }; }
export interface NormalizedThemeTokens { presets: ThemeToken[]; colors: ThemeToken[]; fontFamilies: ThemeToken[]; fontSizes: ThemeToken[]; spacing: ThemeToken[]; }

/** Normalize effective presets. WordPress precedence is core < blocks < theme < user. */
export function parseThemeJsonSettings(settings: unknown): NormalizedThemeTokens {
  const tokens: NormalizedThemeTokens = { presets: [], colors: [], fontFamilies: [], fontSizes: [], spacing: [] };
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return tokens;
  const typed = settings as ThemeJsonSettings;
  tokens.colors = effectiveTokens('color', presetEntries(typed.color?.palette), (entry) => entry.color);
  tokens.fontFamilies = effectiveTokens('font-family', presetEntries(typed.typography?.fontFamilies), (entry) => entry.fontFamily);
  tokens.fontSizes = effectiveTokens('font-size', presetEntries(typed.typography?.fontSizes), (entry) => entry.size);
  tokens.spacing = effectiveTokens('spacing', presetEntries(typed.spacing?.spacingSizes), (entry) => entry.size);
  tokens.presets = [...tokens.colors, ...tokens.fontFamilies, ...tokens.fontSizes, ...tokens.spacing].sort(byToken);
  return tokens;
}
export function themeWarnings(settings: unknown): ContextWarning[] {
  return !settings || typeof settings !== 'object' || Array.isArray(settings)
    ? [{ code: 'theme.settings_unavailable', severity: 'warning', surface: 'theme.settings', message: 'Theme settings could not be normalized.', coverage: 'partial' }]
    : [];
}
type PresetEntry<T> = { entry: T; origin: ThemeTokenOrigin; precedence: number };
function presetEntries<T>(collection: PresetCollection<T> | undefined): PresetEntry<T>[] {
  if (Array.isArray(collection)) return collection.map((entry) => ({ entry, origin: 'unknown', precedence: 0 }));
  if (!collection || typeof collection !== 'object') return [];
  return Object.entries(collection).flatMap(([bucket, entries]) => Array.isArray(entries) ? entries.map((entry) => ({ entry, ...originForBucket(bucket) })) : []);
}
function effectiveTokens<T extends { slug?: string; name?: string }>(kind: ThemeTokenKind, entries: PresetEntry<T>[], valueFor: (entry: T) => string | undefined): ThemeToken[] {
  const winners = new Map<string, { token: ThemeToken; precedence: number }>();
  for (const { entry, origin, precedence } of entries) {
    const value = valueFor(entry);
    if (!entry.slug || !value) continue;
    const candidate = makeToken(kind, entry.slug, value, entry.name, origin);
    const current = winners.get(candidate.id);
    if (!current || precedence > current.precedence || (precedence === current.precedence && byToken(candidate, current.token) < 0)) {
      winners.set(candidate.id, { token: candidate, precedence });
    }
  }
  return [...winners.values()].map(({ token }) => token).sort(byToken);
}
function makeToken(kind: ThemeTokenKind, slug: string, value: string, label: string | undefined, origin: ThemeTokenOrigin): ThemeToken {
  const cssCustomProperty = `--wp--preset--${kind}--${slug}`;
  return { id: `${kind}:${slug}`, kind, slug, ...(label ? { label } : {}), value, origin, references: { cssCustomProperty, cssValue: `var(${cssCustomProperty})`, blockStyle: `var:preset|${kind}|${slug}` } };
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
