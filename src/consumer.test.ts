import { describe, expect, it } from 'vitest';
import { focusContext, lookupField, lookupNativeToken, nativeTokenCoverage, validate, type SiteContext } from './index.js';

const HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

describe('consumer helpers', () => {
  it('uses native references and exact field binding arguments without WordPress calls', () => {
    const context = validContext();
    expect(lookupNativeToken(context, { kind: 'color', slug: 'primary' })).toMatchObject({ status: 'found', coverage: 'complete', sourceManifestHash: HASH, value: { references: { cssCustomProperty: '--wp--preset--color--primary', cssValue: 'var(--wp--preset--color--primary)', blockStyle: 'var:preset|color|primary' } } });
    expect(lookupField(context, { postType: 'product', key: 'price', source: 'core/post-meta' })).toMatchObject({ status: 'found', value: { args: { key: 'price' } } });
  });

  it('distinguishes complete, omitted, legacy, partial, and unavailable native token evidence', () => {
    expect(lookupNativeToken(validContext(), { kind: 'color', slug: 'missing' })).toMatchObject({ status: 'absent', coverage: 'complete' });
    const settingsOnly = rawContext() as any; delete settingsOnly.theme.tokens;
    const omitted = parse(settingsOnly);
    expect(lookupNativeToken(omitted, { kind: 'color', slug: 'missing' })).toMatchObject({ status: 'unknown', coverage: 'unavailable' });
    expect(nativeTokenCoverage(omitted).coverage).toBe(focusContext(omitted, { tokenKinds: ['color'] }).coverage.nativeTokens);
    const legacy = rawContext() as any; legacy.theme.tokens = { colors: [], spacing: [], typography: [] };
    expect(lookupNativeToken(parse(legacy), { kind: 'color', slug: 'missing' })).toMatchObject({ status: 'unknown', coverage: 'unavailable' });
    const empty = rawContext(); empty.theme.tokens = { presets: [] };
    expect(lookupNativeToken(parse(empty), { kind: 'color', slug: 'missing' })).toMatchObject({ status: 'absent', coverage: 'complete' });
    const partial = rawContext(); partial.warnings = [warning('theme.tokens.partial', 'theme.tokens', 'partial')];
    const partialContext = parse(partial);
    expect(lookupNativeToken(partialContext, { kind: 'color', slug: 'primary' })).toMatchObject({ status: 'found', coverage: 'partial' });
    expect(lookupNativeToken(partialContext, { kind: 'color', slug: 'missing' })).toMatchObject({ status: 'unknown', coverage: 'partial' });
    expect(focusContext(partialContext, { tokenKinds: ['color'] }).coverage.nativeTokens).toBe('partial');
    const unavailable = rawContext(); unavailable.warnings = [warning('theme.tokens.unavailable', 'theme.tokens', 'unavailable')];
    const unavailableContext = parse(unavailable);
    expect(lookupNativeToken(unavailableContext, { kind: 'color', slug: 'missing' })).toMatchObject({ status: 'unknown', coverage: 'unavailable' });
    expect(focusContext(unavailableContext, { tokenKinds: ['color'] }).coverage.nativeTokens).toBe('unavailable');
  });

  it('makes deterministic derived views with relevant warnings and only a parent manifest hash', () => {
    const raw = rawContext(); raw.warnings = [warning('media.partial', 'media', 'partial'), warning('blocks.partial', 'blocks', 'partial'), warning('theme.tokens.partial', 'theme.tokens', 'partial')];
    const view = focusContext(parse(raw), { postTypes: ['post', 'product', 'post'], blocks: ['core/paragraph'], tokenKinds: ['spacing', 'color'] });
    expect(view).toMatchObject({ kind: 'wesper.focused-context', derived: true, sourceManifestHash: HASH });
    expect(view).not.toHaveProperty('provenance');
    expect(view.selection).toEqual({ postTypes: ['post', 'product'], blocks: ['core/paragraph'], tokenKinds: ['color', 'spacing'] });
    expect(view.tokens.map((token) => token.id)).toEqual(['color:primary', 'spacing:40']);
    expect(view.warnings.map((item) => item.code)).toEqual(['blocks.partial', 'theme.tokens.partial']);
  });
});

function warning(code: string, surface: string, coverage: 'partial' | 'unavailable') { return { code, severity: 'warning' as const, surface, message: code, coverage }; }
function parse(raw: ReturnType<typeof rawContext>): SiteContext { const result = validate(raw); if (!result.ok || !result.context) throw new Error(JSON.stringify(result.errors)); return result.context; }
function validContext(): SiteContext { return parse(rawContext()); }
function rawContext() {
  const token = (kind: 'color' | 'font-family' | 'font-size' | 'spacing', slug: string, value: string) => ({ id: `${kind}:${slug}`, kind, slug, value, valueSource: 'declared' as const, origin: 'theme' as const, references: { cssCustomProperty: `--wp--preset--${kind}--${slug}`, cssValue: `var(--wp--preset--${kind}--${slug})`, blockStyle: `var:preset|${kind}|${slug}` } });
  return { contextVersion: 1 as const, site: {}, provenance: { collectedAt: '2026-09-06T00:00:00.000Z', collector: 'fixture' as const, collectorVersion: 'test', sourceHash: HASH }, theme: { settings: {}, tokens: { presets: [token('color', 'primary', '#0057ff'), token('font-family', 'body', 'Inter'), token('font-size', 'large', '2rem'), token('spacing', '40', '1rem')] } }, bindings: { available: true, sources: [{ name: 'core/post-meta', usesContext: [], argsSchema: null }], supportedAttributes: {} }, contentModel: { postTypes: [{ name: 'product', fields: [{ name: 'price', key: 'price', source: 'core/post-meta', args: { key: 'price' }, bindable: true }] }, { name: 'post', fields: [] }] }, warnings: [] as ReturnType<typeof warning>[] };
}
