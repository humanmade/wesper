import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  focusContext,
  formatSummaryMarkdown,
  lookupBlock,
  lookupField,
  lookupNativeToken,
  nativeTokenCoverage,
  summarize,
  validate,
  type SiteContext,
} from './index.js';

const HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

describe('consumer helpers', () => {
  it('resolves exact native references for every token kind and verbatim field args', () => {
    const context = validContext();
    const expected = [
      ['color', 'primary', 'var:preset|color|primary'],
      ['font-family', 'body', 'var:preset|font-family|body'],
      ['font-size', 'large', 'var:preset|font-size|large'],
      ['spacing', '40', 'var:preset|spacing|40'],
    ] as const;

    for (const [kind, slug, blockStyle] of expected) {
      const result = lookupNativeToken(context, { kind, slug });
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.value.references).toEqual({
          cssCustomProperty: `--wp--preset--${kind}--${slug}`,
          cssValue: `var(--wp--preset--${kind}--${slug})`,
          blockStyle,
        });
      }
    }

    const price = lookupField(context, { postType: 'product', key: 'price', source: 'core/post-meta' });
    expect(price).toMatchObject({ status: 'found', coverage: 'complete', sourceManifestHash: HASH });
    if (price.status === 'found') {
      expect(price.value.args).toEqual({ key: 'price', default: 0, options: { currency: 'USD', precision: 2 } });
    }
    expect(lookupField(context, { postType: 'product', name: 'date', source: 'core/post-data' })).toMatchObject({
      status: 'found', value: { args: { field: 'date', context: { postId: 42 } } },
    });
  });

  it('distinguishes found, absent, and unknown block and field evidence', () => {
    const complete = validContext();
    expect(lookupBlock(complete, 'core/paragraph')).toMatchObject({ status: 'found', coverage: 'complete' });
    expect(lookupBlock(complete, 'missing/block')).toMatchObject({ status: 'absent', coverage: 'complete' });
    expect(lookupField(complete, { postType: 'product', key: 'missing' })).toMatchObject({ status: 'absent', coverage: 'complete' });

    const omittedBlocks = rawFixture(); delete omittedBlocks.blocks;
    expect(lookupBlock(parse(omittedBlocks), 'missing/block')).toMatchObject({ status: 'unknown', coverage: 'unavailable' });
    const emptyBlocks = rawFixture(); emptyBlocks.blocks = { types: [] };
    expect(lookupBlock(parse(emptyBlocks), 'missing/block')).toMatchObject({ status: 'absent', coverage: 'complete' });

    const omittedFields = rawFixture(); delete omittedFields.contentModel;
    expect(lookupField(parse(omittedFields), { postType: 'product', key: 'missing' })).toMatchObject({ status: 'unknown', coverage: 'unavailable' });
    const emptyFields = rawFixture(); emptyFields.contentModel = { postTypes: [] };
    expect(lookupField(parse(emptyFields), { postType: 'product', key: 'missing' })).toMatchObject({ status: 'absent', coverage: 'complete' });

    const partial = rawFixture(); partial.warnings = [warning('blocks.partial', 'blocks', 'partial'), warning('contentModel.partial', 'contentModel', 'partial')];
    const partialContext = parse(partial);
    expect(lookupBlock(partialContext, 'core/paragraph')).toMatchObject({ status: 'found', coverage: 'partial' });
    expect(lookupBlock(partialContext, 'missing/block')).toMatchObject({ status: 'unknown', coverage: 'partial' });
    expect(lookupField(partialContext, { postType: 'product', key: 'price' })).toMatchObject({ status: 'found', coverage: 'partial' });
    expect(lookupField(partialContext, { postType: 'product', key: 'missing' })).toMatchObject({ status: 'unknown', coverage: 'partial' });
  });

  it('keeps source qualification exact for equal field names', () => {
    const context = validContext();
    expect(lookupField(context, { postType: 'product', key: 'date', source: 'core/post-data' })).toMatchObject({
      status: 'found', value: { args: { field: 'date', context: { postId: 42 } } },
    });
    expect(lookupField(context, { postType: 'product', key: 'date', source: 'core/post-meta' })).toMatchObject({
      status: 'found', value: { args: { key: 'date', fallback: 'Unknown' } },
    });
    expect(lookupField(context, { postType: 'post', key: 'date', source: 'core/post-meta' })).toMatchObject({
      status: 'found', value: { args: { key: 'date', fallback: 'Untitled' } },
    });

    const withoutKey = rawFixture(); delete withoutKey.contentModel.postTypes[0].fields[0].key;
    const withoutKeyContext = parse(withoutKey);
    expect(lookupField(withoutKeyContext, { postType: 'product', key: 'price' })).toMatchObject({ status: 'absent' });
    expect(lookupField(withoutKeyContext, { postType: 'product', name: 'price' })).toMatchObject({ status: 'found' });
    expect(() => lookupField(context, { postType: 'product' } as never)).toThrow('requires a key or name');
  });

  it('preserves native-token omitted, legacy, empty, partial, and unavailable evidence', () => {
    expect(lookupNativeToken(validContext(), { kind: 'color', slug: 'missing' })).toMatchObject({ status: 'absent', coverage: 'complete' });
    const omitted = rawFixture(); delete omitted.theme.tokens;
    const omittedContext = parse(omitted);
    expect(lookupNativeToken(omittedContext, { kind: 'color', slug: 'missing' })).toMatchObject({ status: 'unknown', coverage: 'unavailable' });
    expect(nativeTokenCoverage(omittedContext).coverage).toBe(focusContext(omittedContext, { tokenKinds: ['color'] }).coverage.nativeTokens);
    const settingsOnly = rawFixture(); settingsOnly.theme = { settings: {} };
    const settingsOnlyContext = parse(settingsOnly);
    expect(lookupNativeToken(settingsOnlyContext, { kind: 'color', slug: 'missing' })).toMatchObject({ status: 'unknown', coverage: 'unavailable' });
    expect(nativeTokenCoverage(settingsOnlyContext)).toMatchObject({ surface: 'theme.tokens', coverage: 'unavailable', warnings: [] });
    expect(focusContext(settingsOnlyContext, { tokenKinds: ['color'] }).coverage.nativeTokens).toBe('unavailable');
    const legacy = rawFixture(); legacy.theme.tokens = { colors: [], spacing: [], typography: [] };
    expect(lookupNativeToken(parse(legacy), { kind: 'color', slug: 'missing' })).toMatchObject({ status: 'unknown', coverage: 'unavailable' });
    const empty = rawFixture(); empty.theme.tokens = { presets: [] };
    delete empty.theme.settings;
    const emptyContext = parse(empty);
    expect(emptyContext.warnings).not.toContainEqual(expect.objectContaining({ code: 'theme.invalid_evidence' }));
    expect(lookupNativeToken(emptyContext, { kind: 'color', slug: 'missing' })).toMatchObject({ status: 'absent', coverage: 'complete' });
    const settingsWarning = rawFixture(); settingsWarning.warnings = [warning('theme.settings.partial', 'theme.settings', 'partial')];
    expect(nativeTokenCoverage(parse(settingsWarning))).toMatchObject({ coverage: 'complete', warnings: [] });
    const partial = rawFixture(); partial.warnings = [warning('theme.tokens.partial', 'theme.tokens', 'partial')];
    const partialContext = parse(partial);
    expect(lookupNativeToken(partialContext, { kind: 'color', slug: 'primary' })).toMatchObject({ status: 'found', coverage: 'partial' });
    expect(lookupNativeToken(partialContext, { kind: 'color', slug: 'missing' })).toMatchObject({ status: 'unknown', coverage: 'partial' });
    expect(nativeTokenCoverage(partialContext).coverage).toBe('partial');
    expect(focusContext(partialContext, { tokenKinds: ['color'] }).coverage.nativeTokens).toBe('partial');
    const unavailable = rawFixture(); unavailable.warnings = [warning('theme.tokens.unavailable', 'theme.tokens', 'unavailable')];
    const unavailableContext = parse(unavailable);
    expect(lookupNativeToken(unavailableContext, { kind: 'color', slug: 'missing' })).toMatchObject({ status: 'unknown', coverage: 'unavailable' });
    expect(focusContext(unavailableContext, { tokenKinds: ['color'] }).coverage.nativeTokens).toBe('unavailable');
  });

  it('makes stable derived views with relevant warnings and parent-only identity', () => {
    const raw = rawFixture();
    raw.warnings = [
      warning('media.partial', 'media', 'partial'),
      warning('blocks.partial', 'blocks', 'partial'),
      warning('contentModel.partial', 'contentModel', 'partial'),
      warning('contentModel.post.partial', 'contentModel.postTypes.post.fields', 'partial'),
      warning('contentModel.product.partial', 'contentModel.postTypes.product.fields', 'partial'),
      warning('theme.tokens.partial', 'theme.tokens', 'partial'),
    ];
    const context = parse(raw);
    const before = JSON.stringify(context);
    const options = { postTypes: ['post', 'product', 'post'], blocks: ['core/paragraph', 'core/paragraph'], tokenKinds: ['spacing', 'color', 'color'] as const };
    const view = focusContext(context, options);
    const reordered = rawFixture();
    reordered.blocks.types.reverse();
    reordered.contentModel.postTypes.reverse();
    reordered.theme.tokens.presets.reverse();
    reordered.warnings = raw.warnings;

    expect(view).toMatchObject({ kind: 'wesper.focused-context', derived: true, sourceManifestHash: HASH });
    expect(view).not.toHaveProperty('provenance');
    expect(view).not.toHaveProperty('sourceHash');
    expect(view.selection).toEqual({ postTypes: ['post', 'product'], blocks: ['core/paragraph'], tokenKinds: ['color', 'spacing'] });
    expect(view.postTypes.map((postType) => postType.name)).toEqual(['post', 'product']);
    expect(view.postTypes[1]?.fields.map((field) => field.name)).toEqual(['date', 'date', 'price']);
    expect(view.blocks.map((block) => block.name)).toEqual(['core/paragraph']);
    expect(view.tokens.map((token) => token.id)).toEqual(['color:primary', 'spacing:40']);
    expect(view.warnings.map((item) => item.code)).toEqual(['blocks.partial', 'contentModel.partial', 'contentModel.post.partial', 'contentModel.product.partial', 'theme.tokens.partial']);
    expect(focusContext(context, { postTypes: ['product'] }).warnings.map((item) => item.code)).toEqual([
      'contentModel.partial', 'contentModel.product.partial',
    ]);
    expect(focusContext(context, { postTypes: [], blocks: [], tokenKinds: [] })).toMatchObject({ postTypes: [], blocks: [], tokens: [] });
    expect(focusContext(context, { postTypes: ['product', 'post'], blocks: ['core/paragraph'], tokenKinds: ['color', 'spacing'] })).toEqual(view);
    expect(focusContext(parse(reordered), options)).toEqual(view);
    expect(JSON.stringify(context)).toBe(before);
  });

  it('retains only relevant warnings in a token-only view', () => {
    const raw = rawFixture();
    raw.warnings = [
      warning('settings.partial', 'theme.settings', 'partial'),
      warning('palette.partial', 'theme.settings.color.palette', 'partial'),
      warning('theme.partial', 'theme', 'partial'),
      warning('tokens.partial', 'theme.tokens', 'partial'),
      warning('color.partial', 'theme.tokens.presets.color', 'partial'),
      warning('fonts.partial', 'theme.tokens.presets.font-size', 'partial'),
    ];

    expect(focusContext(parse(raw), { tokenKinds: ['color'] }).warnings.map((item) => item.code)).toEqual([
      'theme.partial', 'tokens.partial', 'color.partial',
    ]);
    expect(focusContext(parse(raw)).warnings).toEqual([]);
  });

  it('reports native-token coverage consistently through summaries and focused views', () => {
    const context = validContext();
    expect(summarize(context).coverage.nativeTokens).toBe(lookupNativeToken(context, { kind: 'color', slug: 'missing' }).coverage);
    expect(focusContext(context, { tokenKinds: ['color'] }).coverage.nativeTokens).toBe(summarize(context).coverage.nativeTokens);
    expect(formatSummaryMarkdown(context)).toContain('- nativeTokens: complete');
    const partial = rawFixture(); partial.warnings = [warning('theme.tokens.partial', 'theme.tokens', 'partial')];
    const partialContext = parse(partial);
    expect(summarize(partialContext).coverage.nativeTokens).toBe(lookupNativeToken(partialContext, { kind: 'color', slug: 'missing' }).coverage);
    expect(focusContext(partialContext, { tokenKinds: ['color'] }).coverage.nativeTokens).toBe(summarize(partialContext).coverage.nativeTokens);
    expect(formatSummaryMarkdown(partialContext)).toContain('- nativeTokens: partial');
  });
});

function warning(code: string, surface: string, coverage: 'partial' | 'unavailable') { return { code, severity: 'warning' as const, surface, message: code, coverage }; }
function rawFixture(): any { return JSON.parse(readFileSync(new URL('../examples/fixtures/consumer-manifest.json', import.meta.url), 'utf8')); }
function parse(raw: unknown): SiteContext { const result = validate(raw); if (!result.ok || !result.context) throw new Error(JSON.stringify(result.errors)); return result.context; }
function validContext(): SiteContext { return parse(rawFixture()); }
