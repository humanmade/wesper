import { describe, expect, it } from 'vitest';
import { sourceHash, validate } from '../index.js';
import { COLLECTOR_VERSION, normalizeCollectorOutput } from './normalize.js';

function rawContentModel(): Record<string, unknown> {
  return {
    site: {},
    wordpress: {},
    theme: { settings: {} },
    plugins: [],
    blocks: { types: [] },
    bindings: { available: false, sources: [], supportedAttributes: {}, warnings: [] },
    contentModel: {
      postTypes: [{
        name: 'product',
        taxonomies: ['product-type'],
        fields: [],
        owner: {
          status: 'matched', kind: 'plugin', slug: 'store/store.php', evidence: 'registration-call', path: 'includes/content.php',
        },
      }],
      taxonomies: [{
        name: 'product-type',
        objectTypes: ['product', 'post'],
        owner: {
          status: 'unknown', reason: 'registration_not_observed',
        },
      }],
    },
    patterns: { items: [] },
    media: { imageSizes: [] },
    warnings: [],
  };
}

describe('content ownership normalization', () => {
  it('keeps existing manifests without content owners or taxonomy records valid', () => {
    const raw = rawContentModel();
    const contentModel = raw.contentModel as Record<string, unknown>;
    delete contentModel.taxonomies;
    delete (contentModel.postTypes as Array<Record<string, unknown>>)[0]!.owner;

    const context = normalizeCollectorOutput(raw, { collector: 'wp-cli', collectorVersion: 'test' });

    expect(context.contentModel?.taxonomies).toBeUndefined();
    expect(context.contentModel?.postTypes[0]).not.toHaveProperty('owner');
    expect(validate(context).ok).toBe(true);
  });

  it('rejects invalid registration ownership evidence and statuses', () => {
    const invalidEvidence = manifest();
    ((invalidEvidence.contentModel as Record<string, unknown>).postTypes as Array<Record<string, unknown>>)[0]!.owner = {
      status: 'matched', kind: 'plugin', slug: 'store/store.php', evidence: 'block-metadata', path: 'includes/content.php',
    };
    const invalidStatus = manifest();
    ((invalidStatus.contentModel as Record<string, unknown>).taxonomies as Array<Record<string, unknown>>)[0]!.owner = {
      status: 'unknown', reason: 'metadata_not_found',
    };
    const missingObjectTypes = manifest();
    delete ((missingObjectTypes.contentModel as Record<string, unknown>).taxonomies as Array<Record<string, unknown>>)[0]!.objectTypes;

    expect(validate(invalidEvidence).ok).toBe(false);
    expect(validate(invalidStatus).ok).toBe(false);
    expect(validate(missingObjectTypes).ok).toBe(false);
  });

  it('sorts taxonomy rows and object types before hashing', () => {
    const first = rawContentModel();
    const second = rawContentModel();
    const taxonomies = (second.contentModel as Record<string, unknown>).taxonomies as Array<Record<string, unknown>>;
    taxonomies.unshift({ name: 'audience', objectTypes: ['product', 'post'] });
    taxonomies[1]!.objectTypes = ['post', 'product'];
    const firstTaxonomies = (first.contentModel as Record<string, unknown>).taxonomies as Array<Record<string, unknown>>;
    firstTaxonomies.push({ name: 'audience', objectTypes: ['post', 'product'] });

    const normalizedFirst = normalizeCollectorOutput(first, { collector: 'wp-cli', collectorVersion: 'test' });
    const normalizedSecond = normalizeCollectorOutput(second, { collector: 'wp-cli', collectorVersion: 'test' });

    expect(normalizedSecond.contentModel?.taxonomies?.map((taxonomy) => taxonomy.name)).toEqual(['audience', 'product-type']);
    expect(normalizedSecond.contentModel?.taxonomies?.[1]?.objectTypes).toEqual(['post', 'product']);
    expect(normalizedFirst.provenance.sourceHash).toBe(normalizedSecond.provenance.sourceHash);
    expect(normalizedFirst.provenance.sourceHash).toBe(sourceHash(normalizedFirst));
  });

  it('does not invent REST ownership', () => {
    const raw = rawContentModel();
    const contentModel = raw.contentModel as Record<string, unknown>;
    delete (contentModel.postTypes as Array<Record<string, unknown>>)[0]!.owner;
    delete ((contentModel.taxonomies as Array<Record<string, unknown>>)[0]!.owner);

    const context = normalizeCollectorOutput(raw, { collector: 'rest', collectorVersion: 'test' });

    expect(context.contentModel?.postTypes[0]).not.toHaveProperty('owner');
    expect(context.contentModel?.taxonomies?.[0]).not.toHaveProperty('owner');
  });

  it('preserves valid post types while omitting malformed taxonomy evidence', () => {
    const raw = rawContentModel();
    (raw.contentModel as Record<string, unknown>).taxonomies = [{ name: 'product-type' }];

    const context = normalizeCollectorOutput(raw, { collector: 'wp-cli', collectorVersion: 'test' });

    expect(context.contentModel?.postTypes.map((postType) => postType.name)).toEqual(['product']);
    expect(context.contentModel?.taxonomies).toBeUndefined();
    expect(context.warnings).toContainEqual(expect.objectContaining({
      code: 'contentModel.taxonomies.invalid_evidence', surface: 'contentModel.taxonomies', coverage: 'partial',
    }));
  });
});

function manifest(): Record<string, unknown> {
  const context = normalizeCollectorOutput(rawContentModel(), { collector: 'wp-cli', collectorVersion: COLLECTOR_VERSION });
  return { ...context, provenance: { ...context.provenance, sourceHash: sourceHash(context) } };
}
