import type { ContextWarning, SiteContext, Summary } from './types.js';
import {
  REQUIRED_STRICT_SURFACES,
  allWarnings,
  coverageFor,
  type CollectionSurface,
  type CoverageStatus,
  type SurfaceCoverage,
} from './warnings.js';

export function summarize(context: SiteContext): Summary {
  const postTypes = context.contentModel?.postTypes;
  const fieldsByPostType = postTypes
    ? Object.fromEntries(
        postTypes.map((postType) => [postType.name, postType.fields?.filter((field) => field.bindable).length ?? 0]),
      )
    : {};

  const warnings = allWarnings(context);
  const surfaceCoverage = coverageFor(context);
  const coverage = Object.fromEntries(surfaceCoverage.map(({ surface, status }) => [surface, status]));
  const bindingWork = bindingWorkFor(surfaceCoverage);
  const supportedWork = [...bindingWork.supported, ...surfaceCoverage.flatMap((item) => supportedWorkFor(item.surface, item.status))];
  const unknownWork = [...bindingWork.unknown, ...surfaceCoverage.flatMap((item) => unknownWorkFor(item.surface, item.status))];

  return {
    site: {
      url: context.site.url,
      wordpressVersion: context.wordpress?.version,
      theme: context.theme?.name ?? context.theme?.stylesheet,
      collector: context.provenance.collector,
      collectedAt: context.provenance.collectedAt,
      sourceHash: context.provenance.sourceHash,
    },
    counts: {
      blockTypes: context.blocks ? (context.blocks.types?.length ?? 0) : 'absent',
      bindingSources: context.bindings ? (context.bindings.sources?.length ?? 0) : 'absent',
      postTypes: postTypes ? postTypes.length : 'absent',
      bindableFields: postTypes ? Object.values(fieldsByPostType).reduce((sum, count) => sum + count, 0) : 'absent',
      patterns: context.patterns ? (context.patterns.items?.length ?? 0) : 'absent',
      plugins: context.plugins ? context.plugins.length : 'absent',
      imageSizes: context.media ? (context.media.imageSizes?.length ?? 0) : 'absent',
      warnings: warnings.length,
    },
    bindingReadiness: {
      supportedAttributes: context.bindings?.supportedAttributes ?? {},
      fieldsByPostType,
    },
    coverage,
    supportedWork,
    unknownWork,
    warningsBySurface: groupWarnings(warnings),
  };
}

export function formatSummaryMarkdown(context: SiteContext): string {
  const summary = summarize(context);
  const lines = [
    `# Wesper Context Summary`,
    ``,
    `- Site: ${summary.site.url ?? 'unknown'}`,
    `- WordPress: ${summary.site.wordpressVersion ?? 'unknown'}`,
    `- Theme: ${summary.site.theme ?? 'unknown'}`,
    `- Collector: ${summary.site.collector}`,
    `- Source hash: ${summary.site.sourceHash}`,
    ``,
    `## Counts`,
    ``,
    `- Block types: ${formatCount(summary.counts.blockTypes)}`,
    `- Binding sources: ${formatCount(summary.counts.bindingSources)}`,
    `- Post types: ${formatCount(summary.counts.postTypes)}`,
    `- Bindable fields: ${formatCount(summary.counts.bindableFields)}`,
    `- Patterns: ${formatCount(summary.counts.patterns)}`,
    `- Plugins: ${formatCount(summary.counts.plugins)}`,
    `- Image sizes: ${formatCount(summary.counts.imageSizes)}`,
    `- Warnings: ${summary.counts.warnings}`,
    ``,
    `## Evidence`,
    ``,
    `### Coverage`,
    ``,
  ];

  for (const [surface, status] of Object.entries(summary.coverage)) {
    lines.push(`- ${surface}: ${status}`);
  }

  lines.push(
    '',
    `### Supported Work`,
    ``,
  );

  if (summary.supportedWork.length > 0) {
    for (const work of summary.supportedWork) {
      lines.push(`- ${work}`);
    }
  } else {
    lines.push('- No supported work is established by the collected evidence.');
  }

  lines.push('', '### Remaining Unknowns', '');
  if (summary.unknownWork.length > 0) {
    for (const unknown of summary.unknownWork) {
      lines.push(`- ${unknown}`);
    }
  } else {
    lines.push('- No collection gaps were reported.');
  }

  lines.push(
    '',
    `## Binding Readiness`,
    ``,
  );

  for (const [blockName, attributes] of Object.entries(summary.bindingReadiness.supportedAttributes).sort()) {
    lines.push(`- ${blockName}: ${attributes.join(', ') || 'none'}`);
  }
  if (Object.keys(summary.bindingReadiness.supportedAttributes).length === 0) {
    lines.push('- No supported binding attributes reported.');
  }

  lines.push('', '## Fields By Post Type', '');
  for (const [postType, count] of Object.entries(summary.bindingReadiness.fieldsByPostType).sort()) {
    lines.push(`- ${postType}: ${count}`);
  }
  if (Object.keys(summary.bindingReadiness.fieldsByPostType).length === 0) {
    lines.push('- No post types reported.');
  }

  if (summary.counts.warnings > 0) {
    lines.push('', '## Warnings', '');
    for (const [surface, warnings] of Object.entries(summary.warningsBySurface).sort()) {
      for (const warning of warnings) {
        lines.push(`- ${surface}: [${warning.code}] ${warning.message}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function groupWarnings(warnings: ContextWarning[]): Record<string, ContextWarning[]> {
  const grouped: Record<string, ContextWarning[]> = {};
  for (const warning of warnings) {
    grouped[warning.surface] ??= [];
    grouped[warning.surface]?.push(warning);
  }
  return grouped;
}

function formatCount(count: number | 'absent'): string {
  return count === 'absent' ? 'absent (see warnings)' : String(count);
}

function supportedWorkFor(surface: CollectionSurface, status: CoverageStatus): string[] {
  if (status === 'unavailable') {
    return [];
  }

  const partial = status === 'partial';
  const qualifier = partial ? 'Use only the reported' : 'Use the reported';

  switch (surface) {
    case 'wordpress':
      return [`${qualifier} WordPress version and capabilities${partial ? '; unreported capabilities remain unknown.' : '.'}`];
    case 'theme':
      return [`${qualifier} theme settings and tokens${partial ? '; unreported theme evidence remains unknown.' : '.'}`];
    case 'plugins':
      return [`${qualifier} plugins${partial ? '; plugin evidence is incomplete.' : '.'}`];
    case 'blocks':
      return [`${qualifier} block types and their attributes${partial ? '; block evidence is incomplete.' : '.'}`];
    case 'bindings':
      return [`${qualifier} binding sources and supported block attributes${partial ? '; binding evidence is incomplete.' : '.'}`];
    case 'contentModel':
      return [`${qualifier} bindable post-type fields and their binding arguments${partial ? '; additional fields may be unknown.' : '.'}`];
    case 'patterns':
      return [`${qualifier} block patterns${partial ? '; pattern evidence is incomplete.' : '.'}`];
    case 'media':
      return [`${qualifier} registered image sizes${partial ? '; media evidence is incomplete.' : '.'}`];
  }

  return [];
}

function unknownWorkFor(surface: CollectionSurface, status: CoverageStatus): string[] {
  if (status === 'complete') {
    return [];
  }

  const subject = {
    wordpress: 'WordPress version and capability evidence',
    theme: 'Theme settings and token evidence',
    plugins: 'Plugin evidence',
    blocks: 'Block type and attribute evidence',
    bindings: 'Binding source and supported-attribute evidence',
    contentModel: 'Bindable post-type field evidence',
    patterns: 'Block pattern evidence',
    media: 'Registered image-size evidence',
  }[surface];

  return [
    status === 'partial'
      ? `${subject} is partial; do not assume unreported data is empty.`
      : `${subject} is unavailable; do not assume the surface is empty.`,
  ];
}

function bindingWorkFor(surfaceCoverage: SurfaceCoverage[]): { supported: string[]; unknown: string[] } {
  const requiredCoverage = REQUIRED_STRICT_SURFACES.map((surface) =>
    surfaceCoverage.find((item) => item.surface === surface),
  );
  const gaps = requiredCoverage.filter((item): item is SurfaceCoverage => item !== undefined && item.status !== 'complete');

  if (gaps.length === 0) {
    return {
      supported: ['Create bindings by joining the reported block attributes with the reported post-type fields.'],
      unknown: [],
    };
  }

  return {
    supported: [],
    unknown: [
      `Complete binding work is not supported until ${gaps.map((item) => surfaceLabel(item.surface)).join(', ')} evidence is complete.`,
    ],
  };
}

function surfaceLabel(surface: CollectionSurface): string {
  return {
    wordpress: 'WordPress capability',
    theme: 'theme',
    plugins: 'plugin',
    blocks: 'block type and attribute',
    bindings: 'binding source and supported-attribute',
    contentModel: 'bindable post-type field',
    patterns: 'block pattern',
    media: 'registered image-size',
  }[surface];
}
