import type { ContextWarning } from './types.js';

interface ThemeJsonSettings {
  color?: { palette?: PresetCollection<{ slug?: string; name?: string; color?: string }> };
  typography?: {
    fontFamilies?: PresetCollection<{ slug?: string; name?: string; fontFamily?: string }>;
    fontSizes?: PresetCollection<{ slug?: string; name?: string; size?: string }>;
  };
  spacing?: { spacingSizes?: PresetCollection<{ slug?: string; name?: string; size?: string }> };
}

type PresetCollection<T> = T[] | Record<string, T[]>;

export interface NormalizedThemeTokens {
  colors: Array<{ slug: string; name?: string; value: string }>;
  spacing: Array<{ slug: string; name?: string; value: string }>;
  typography: Array<{ slug: string; name?: string; value: string }>;
}

export function parseThemeJsonSettings(settings: unknown): NormalizedThemeTokens {
  const tokens: NormalizedThemeTokens = { colors: [], spacing: [], typography: [] };
  if (!settings || typeof settings !== 'object') {
    return tokens;
  }

  const typed = settings as ThemeJsonSettings;
  for (const entry of presetEntries(typed.color?.palette)) {
    if (entry.slug && entry.color) {
      tokens.colors.push(token(entry.slug, entry.color, entry.name));
    }
  }
  for (const entry of presetEntries(typed.typography?.fontFamilies)) {
    if (entry.slug && entry.fontFamily) {
      tokens.typography.push(token(entry.slug, entry.fontFamily, entry.name));
    }
  }
  for (const entry of presetEntries(typed.typography?.fontSizes)) {
    if (entry.slug && entry.size) {
      tokens.typography.push(token(entry.slug, entry.size, entry.name));
    }
  }
  for (const entry of presetEntries(typed.spacing?.spacingSizes)) {
    if (entry.slug && entry.size) {
      tokens.spacing.push(token(entry.slug, entry.size, entry.name));
    }
  }

  tokens.colors.sort(byToken);
  tokens.spacing.sort(byToken);
  tokens.typography.sort(byToken);
  return tokens;
}

export function themeWarnings(settings: unknown): ContextWarning[] {
  if (!settings || typeof settings !== 'object') {
    return [
      {
        code: 'theme.settings_unavailable',
        severity: 'warning',
        surface: 'theme.settings',
        message: 'Theme settings could not be normalized.',
        coverage: 'partial',
      },
    ];
  }
  return [];
}

function token(slug: string, value: string, name?: string): { slug: string; name?: string; value: string } {
  return name ? { slug, name, value } : { slug, value };
}

function presetEntries<T>(collection: PresetCollection<T> | undefined): T[] {
  if (Array.isArray(collection)) {
    return collection;
  }
  if (!collection || typeof collection !== 'object') {
    return [];
  }
  return Object.values(collection).flatMap((value) => (Array.isArray(value) ? value : []));
}

function byToken(
  left: { slug: string; name?: string; value: string },
  right: { slug: string; name?: string; value: string },
): number {
  return (
    compareStrings(left.slug, right.slug) ||
    compareStrings(left.name ?? '', right.name ?? '') ||
    compareStrings(left.value, right.value)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
