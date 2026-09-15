import { describe, expect, it } from 'vitest';
import { sourceHash, validate } from '../index.js';
import { normalizeCollectorOutput } from './normalize.js';

function fixture(): Record<string, unknown> {
  return {
    site: {},
    wordpress: {},
    theme: { settings: {} },
    plugins: [],
    blocks: {
      types: [
        {
          name: 'acme/complete',
          attributes: { content: { type: 'string' }, itemId: { type: 'string' } },
          supports: {},
          source: 'plugin',
          providesContext: { 'acme/item': 'itemId' },
        },
      ],
    },
    bindings: { available: true, sources: [], supportedAttributes: { 'acme/complete': ['content'] }, warnings: [] },
    contentModel: { postTypes: [] },
    patterns: { items: [] },
    media: { imageSizes: [] },
    warnings: [],
  };
}

function normalize(raw: Record<string, unknown>, collector: 'wp-cli' | 'rest') {
  return normalizeCollectorOutput(raw, { collector, collectorVersion: 'test' });
}

describe('binding consistency warnings', () => {
  it('leaves valid binding and context mappings warning-free for both collectors', () => {
    for (const collector of ['wp-cli', 'rest'] as const) {
      const context = normalize(fixture(), collector);

      expect(context.warnings).toEqual([]);
      expect(validate(context).ok).toBe(true);
      expect(context.provenance.sourceHash).toBe(sourceHash(context));
    }
  });

  it('warns for missing registered attributes without changing either registry', () => {
    const raw = fixture();
    const blocks = (raw.blocks as { types: Array<Record<string, unknown>> }).types;
    blocks.push({
      name: 'acme/missing',
      attributes: { title: { type: 'string' } },
      supports: {},
      source: 'plugin',
      providesContext: { 'acme/item': 'itemId' },
    });
    (raw.bindings as { supportedAttributes: Record<string, string[]> }).supportedAttributes = {
      'missing/block': ['ignored'],
      'acme/missing': ['content'],
      'acme/complete': ['content'],
    };

    for (const collector of ['wp-cli', 'rest'] as const) {
      const context = normalize(raw, collector);
      const warnings = context.warnings.filter((warning) => warning.code.endsWith('_attribute_missing'));

      expect(warnings.map((warning) => [warning.surface, warning.code])).toEqual([
        ['bindings.supportedAttributes.acme/missing.content', 'bindings.supported_attribute_missing'],
        ['blocks.types.acme/missing.providesContext.acme/item', 'blocks.provides_context_attribute_missing'],
      ]);
      expect(context.bindings?.supportedAttributes).toEqual({
        'acme/complete': ['content'],
        'acme/missing': ['content'],
        'missing/block': ['ignored'],
      });
      expect(context.blocks?.types.find((block) => block.name === 'acme/missing')?.providesContext).toEqual({ 'acme/item': 'itemId' });
      expect(validate(context).ok).toBe(true);
      expect(context.provenance.sourceHash).toBe(sourceHash(context));
    }
  });

  it('warns for missing context attributes when REST binding evidence is unavailable', () => {
    const raw = fixture();
    (raw.blocks as { types: Array<Record<string, unknown>> }).types[0]!.providesContext = { 'acme/item': 'missingId' };
    delete raw.bindings;

    const context = normalize(raw, 'rest');

    expect(context.warnings).toContainEqual(expect.objectContaining({
      code: 'blocks.provides_context_attribute_missing',
      surface: 'blocks.types.acme/complete.providesContext.acme/item',
      coverage: 'partial',
    }));
    expect(context.bindings).toBeUndefined();
    expect(validate(context).ok).toBe(true);
    expect(context.provenance.sourceHash).toBe(sourceHash(context));
  });
});
