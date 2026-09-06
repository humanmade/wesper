import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkBindingReference,
  checkTokenReference,
  validate,
  type SiteContext,
} from './index.js';

const HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const PRICE = {
  block: 'core/paragraph',
  attribute: 'content',
  source: 'core/post-meta',
  field: { postType: 'product', key: 'price' },
} as const;

describe('reference compatibility', () => {
  it('supports every explicit native token kind and reports verbatim references', () => {
    const context = validContext();
    for (const [kind, slug, id] of [
      ['color', 'primary', 'color:primary'],
      ['font-family', 'body', 'font-family:body'],
      ['font-size', 'large', 'font-size:large'],
      ['spacing', '40', 'spacing:40'],
    ] as const) {
      const result = checkTokenReference(context, { kind, slug });
      expect(result).toMatchObject({
        status: 'compatible',
        sourceManifestHash: HASH,
        reasons: [{ code: 'token.found', coverage: 'complete', evidence: ['theme.tokens.presets', `theme.tokens.presets.id:${id}.kind:${kind}.slug:${slug}`] }],
      });
      expect(result.token?.references).toEqual({
        cssCustomProperty: `--wp--preset--${kind}--${slug}`,
        cssValue: `var(--wp--preset--${kind}--${slug})`,
        blockStyle: `var:preset|${kind}|${slug}`,
      });
      expect(result.evidence).toEqual(expect.arrayContaining(['theme.tokens.presets', `theme.tokens.presets.id:${id}.kind:${kind}.slug:${slug}`]));
    }
  });

  it('distinguishes complete absence from omitted, legacy, and partial native-token evidence', () => {
    expect(checkTokenReference(validContext(), { kind: 'color', slug: 'missing' })).toMatchObject({
      status: 'incompatible',
      reasons: [{ code: 'token.absent', coverage: 'complete', evidence: ['theme.tokens.presets', 'theme.tokens.presets.kind:color.slug:missing'] }],
    });

    const empty = rawFixture(); empty.theme.tokens = { presets: [] };
    expect(checkTokenReference(parse(empty), { kind: 'color', slug: 'missing' })).toMatchObject({
      status: 'incompatible',
      reasons: [{ code: 'token.absent', coverage: 'complete', evidence: ['theme.tokens.presets', 'theme.tokens.presets.kind:color.slug:missing'] }],
    });

    const omitted = rawFixture(); delete omitted.theme.tokens;
    const legacy = rawFixture(); legacy.theme.tokens = { colors: [], spacing: [], typography: [] };
    const partial = rawFixture(); partial.warnings = [warning('tokens.partial', 'theme.tokens', 'partial')];
    for (const raw of [omitted, legacy, partial]) {
      const result = checkTokenReference(parse(raw), { kind: 'color', slug: 'missing' });
      expect(result.status).toBe('unknown');
      expect(result.reasons[0]).toMatchObject({ code: 'token.unknown' });
    }
  });

  it('does not pick an arbitrary duplicate native-token identity', () => {
    const raw = rawFixture();
    raw.theme.tokens.presets.push({ ...raw.theme.tokens.presets[0], value: '#0000ff' });
    const result = checkTokenReference(parse(raw), { kind: 'color', slug: 'primary' });
    expect(result).toMatchObject({
      status: 'unknown',
      reasons: [{ code: 'token.ambiguous', evidence: ['theme.tokens.presets', 'theme.tokens.presets.kind:color.slug:primary'] }],
    });
  });

  it('checks each binding prerequisite, preserves field args, and keeps sources qualified', () => {
    const result = checkBindingReference(validContext(), PRICE);
    expect(result).toMatchObject({
      status: 'compatible',
      sourceManifestHash: HASH,
      reasons: [
        { code: 'block.found', evidence: ['blocks.types.core/paragraph'] },
        { code: 'binding_attribute.found', evidence: ['bindings.supportedAttributes.core/paragraph.content'] },
        { code: 'binding_source.found', evidence: ['bindings.sources.core/post-meta'] },
        { code: 'field.found', evidence: ['contentModel.postTypes.product.fields.core/post-meta.key:price'] },
      ],
    });
    expect(result).toMatchObject({
      binding: {
        source: { name: 'core/post-meta', usesContext: ['postId'], argsSchema: null },
        field: { args: { key: 'price', default: 0, options: { currency: 'USD', precision: 2 } } },
      },
    });

    const dataDate = checkBindingReference(validContext(), {
      ...PRICE,
      source: 'core/post-data',
      field: { postType: 'product', key: 'date' },
    });
    const metaDate = checkBindingReference(validContext(), {
      ...PRICE,
      field: { postType: 'product', key: 'date' },
    });
    expect(dataDate).toMatchObject({ status: 'compatible', binding: { field: { args: { field: 'date', context: { postId: 42 } } } } });
    expect(metaDate).toMatchObject({ status: 'compatible', binding: { field: { args: { key: 'date', fallback: 'Unknown' } } } });
  });

  it('reports evidenced incompatibility, conservative unknowns, and every prerequisite reason', () => {
    const complete = validContext();
    expectReason(checkBindingReference(complete, { ...PRICE, block: 'missing/block' }), 'incompatible', { code: 'block.absent', coverage: 'complete' });
    expectReason(checkBindingReference(complete, { ...PRICE, attribute: 'url' }), 'incompatible', { code: 'binding_attribute.absent', coverage: 'complete' });
    expectReason(checkBindingReference(complete, { ...PRICE, source: 'missing/source' }), 'incompatible', { code: 'binding_source.absent', coverage: 'complete' });
    expectReason(checkBindingReference(complete, { ...PRICE, field: { postType: 'product', key: 'missing' } }), 'incompatible', { code: 'field.absent', coverage: 'complete' });

    const nonBindable = rawFixture(); nonBindable.contentModel.postTypes[0].fields[0].bindable = false;
    expectReason(checkBindingReference(parse(nonBindable), PRICE), 'incompatible', { code: 'field.not_bindable' });

    const unavailable = rawFixture(); unavailable.bindings = { available: false, sources: [], supportedAttributes: {} };
    for (const postType of unavailable.contentModel.postTypes) for (const field of postType.fields) field.bindable = false;
    delete unavailable.contentModel.postTypes[0].fields;
    const unavailableResult = checkBindingReference(parse(unavailable), PRICE);
    expect(unavailableResult.status).toBe('unknown');
    expect(unavailableResult.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(['binding_attribute.unknown', 'binding_source.unknown']));

    const mixed = rawFixture(); delete mixed.contentModel.postTypes[0].fields;
    const mixedResult = checkBindingReference(parse(mixed), { ...PRICE, block: 'missing/block' });
    expect(mixedResult.status).toBe('incompatible');
    expect(mixedResult.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(['block.absent', 'field.unknown']));
  });

  it('does not turn schema defaults into successful binding evidence and retains warnings from both locations', () => {
    const missingAttributes = rawFixture(); delete missingAttributes.bindings.supportedAttributes;
    const attributesResult = checkBindingReference(parse(missingAttributes), PRICE);
    expect(attributesResult.status).toBe('unknown');
    expect(attributesResult.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'binding_attribute.unknown', coverage: 'partial' }),
    ]));

    const missingFields = rawFixture(); delete missingFields.contentModel.postTypes[0].fields;
    const fieldsResult = checkBindingReference(parse(missingFields), PRICE);
    expect(fieldsResult.status).toBe('unknown');
    expect(fieldsResult.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'field.unknown', coverage: 'partial' }),
    ]));

    const warnings = rawFixture();
    warnings.warnings = [warning('blocks.partial', 'blocks', 'partial')];
    warnings.bindings.warnings = [warning('attributes.partial', 'bindings.supportedAttributes.core/paragraph', 'partial')];
    const warningResult = checkBindingReference(parse(warnings), { ...PRICE, attribute: 'missing' });
    expect(warningResult.status).toBe('unknown');
    expect(warningResult.reasons.find((reason) => reason.code === 'block.found')?.warnings.map((item) => item.code)).toEqual(['blocks.partial']);
    expect(warningResult.reasons.find((reason) => reason.code === 'binding_attribute.unknown')?.warnings.map((item) => item.code)).toEqual(['attributes.partial']);
  });

  it('keeps source and supported-attribute coverage independent and rejects conflicting nested sources', () => {
    const raw = rawFixture();
    raw.bindings.warnings = [warning('attributes.partial', 'bindings.supportedAttributes.core/paragraph', 'partial')];
    const result = checkBindingReference(parse(raw), { ...PRICE, source: 'missing/source' });
    expect(result.status).toBe('incompatible');
    expect(result.reasons.find((reason) => reason.code === 'binding_source.absent')).toMatchObject({ coverage: 'complete' });

    const conflict = checkBindingReference(validContext(), {
      ...PRICE,
      field: { postType: 'product', key: 'price', source: 'core/post-data' } as any,
    });
    expect(conflict.status).toBe('unknown');
    expect(conflict.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'field.source_conflict' }),
    ]));
  });

  it('identifies every supplied field selector component in evidence', () => {
    const result = checkBindingReference(validContext(), {
      ...PRICE,
      field: { postType: 'product', key: 'price', name: 'wrong-name' },
    });
    expect(result.reasons.find((reason) => reason.code === 'field.absent')?.evidence).toEqual([
      'contentModel.postTypes.product.fields.core/post-meta.key:price.name:wrong-name',
    ]);
  });

  it('uses identifier paths independent of registry order and never mutates input', () => {
    const raw = rawFixture();
    const context = parse(raw);
    const before = JSON.stringify(context);
    const reordered = rawFixture();
    reordered.blocks.types.reverse();
    reordered.bindings.sources.reverse();
    reordered.contentModel.postTypes.reverse();
    reordered.theme.tokens.presets.reverse();
    const reference = PRICE;
    expect(checkBindingReference(parse(reordered), reference)).toEqual(checkBindingReference(context, reference));
    expect(checkTokenReference(parse(reordered), { kind: 'color', slug: 'primary' })).toEqual(checkTokenReference(context, { kind: 'color', slug: 'primary' }));
    expect(JSON.stringify(context)).toBe(before);
  });
});

function warning(code: string, surface: string, coverage: 'partial' | 'unavailable') {
  return { code, severity: 'warning' as const, surface, message: code, coverage };
}

function rawFixture(): any {
  return JSON.parse(readFileSync(new URL('../examples/fixtures/consumer-manifest.json', import.meta.url), 'utf8'));
}

function parse(raw: unknown): SiteContext {
  const result = validate(raw);
  if (!result.ok || !result.context) throw new Error(JSON.stringify(result.errors));
  return result.context;
}

function validContext(): SiteContext { return parse(rawFixture()); }

function expectReason(result: ReturnType<typeof checkBindingReference>, status: string, reason: Record<string, unknown>): void {
  expect(result.status).toBe(status);
  expect(result.reasons).toEqual(expect.arrayContaining([expect.objectContaining(reason)]));
}
