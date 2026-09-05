import { describe, expect, it } from 'vitest';
import { siteContextSchema } from './schema.js';
import { allWarnings, coverageFor, strictCoverageGaps } from './warnings.js';

describe('warning coverage', () => {
  it('flattens top-level and nested binding warnings in one validation view', () => {
    const context = manifest({
      warnings: [warning('bindings.sources_partial', 'info', 'bindings.sources')],
      bindings: {
        available: true,
        sources: [],
        supportedAttributes: {},
        warnings: [warning('bindings.supported_attributes_partial', 'warning', 'bindings.supportedAttributes')],
      },
    });

    expect(allWarnings(context)).toEqual([
      warning('bindings.sources_partial', 'info', 'bindings.sources'),
      warning('bindings.supported_attributes_partial', 'warning', 'bindings.supportedAttributes'),
    ]);
    expect(coverageFor(context).find((coverage) => coverage.surface === 'bindings')).toMatchObject({
      status: 'partial',
      warnings: [
        warning('bindings.sources_partial', 'info', 'bindings.sources'),
        warning('bindings.supported_attributes_partial', 'warning', 'bindings.supportedAttributes'),
      ],
    });
  });

  it('does not treat a successfully observed empty surface as missing', () => {
    const context = manifest({
      bindings: { available: true, sources: [], supportedAttributes: {}, warnings: [] },
      contentModel: { postTypes: [] },
      warnings: [warning('content_model.no_registered_meta', 'info', 'contentModel.postTypes.post.fields', 'complete')],
    });

    expect(coverageFor(context, ['bindings', 'contentModel'])).toEqual([
      { surface: 'bindings', status: 'complete', warnings: [] },
      {
        surface: 'contentModel',
        status: 'complete',
        warnings: [warning('content_model.no_registered_meta', 'info', 'contentModel.postTypes.post.fields', 'complete')],
      },
    ]);
  });

  it('derives gaps from evidence rather than warning severity', () => {
    const context = manifest({
      warnings: [warning('bindings.rest_unavailable', 'info', 'bindings', 'unavailable')],
    });
    delete context.bindings;

    expect(coverageFor(context, ['bindings'])).toEqual([
      {
        surface: 'bindings',
        status: 'unavailable',
        warnings: [warning('bindings.rest_unavailable', 'info', 'bindings', 'unavailable')],
      },
    ]);
    expect(strictCoverageGaps(context)).toEqual([
      {
        surface: 'bindings',
        status: 'unavailable',
        warnings: [warning('bindings.rest_unavailable', 'info', 'bindings', 'unavailable')],
      },
    ]);
  });

  it('marks a collector-reported unavailable binding capability as unavailable', () => {
    const context = manifest({
      bindings: { available: false, sources: [], supportedAttributes: {}, warnings: [] },
    });

    expect(coverageFor(context, ['bindings'])).toEqual([{ surface: 'bindings', status: 'unavailable', warnings: [] }]);
  });

  it('treats unclassified top-level and nested binding warnings as partial', () => {
    const context = manifest({
      warnings: [warning('bindings.read_failed', 'info', 'bindings')],
      bindings: {
        available: true,
        sources: [],
        supportedAttributes: {},
        warnings: [warning('bindings.sources.read_failed', 'info', 'bindings.sources')],
      },
    });

    expect(coverageFor(context, ['bindings'])).toMatchObject([{ status: 'partial' }]);
    expect(strictCoverageGaps(context)).toContainEqual(expect.objectContaining({ surface: 'bindings', status: 'partial' }));
  });
});

function manifest(overrides: Record<string, unknown> = {}) {
  return siteContextSchema.parse({
    contextVersion: 1,
    site: {},
    provenance: {
      collectedAt: '2026-06-25T00:00:00.000Z',
      collector: 'fixture',
      collectorVersion: '0.1.0',
      sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    },
    wordpress: {},
    theme: { settings: {} },
    plugins: [],
    blocks: { types: [] },
    bindings: { available: true, sources: [], supportedAttributes: {}, warnings: [] },
    contentModel: { postTypes: [] },
    patterns: { items: [] },
    media: { imageSizes: [] },
    warnings: [],
    ...overrides,
  });
}

function warning(
  code: string,
  severity: 'info' | 'warning' | 'error',
  surface: string,
  coverage?: 'complete' | 'partial' | 'unavailable',
) {
  return { code, severity, surface, message: `${code} evidence gap`, ...(coverage ? { coverage } : {}) };
}
