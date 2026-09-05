import type { ContextWarning, SiteContext, Summary } from './types.js';
import { allWarnings } from './warnings.js';

export function summarize(context: SiteContext): Summary {
  const postTypes = context.contentModel?.postTypes;
  const fieldsByPostType = postTypes
    ? Object.fromEntries(
        postTypes.map((postType) => [postType.name, postType.fields?.filter((field) => field.bindable).length ?? 0]),
      )
    : {};

  const warnings = allWarnings(context);

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
    `## Binding Readiness`,
    ``,
  ];

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
  // Warning surfaces come from manifests, so they can be names such as
  // "constructor" or "__proto__". A prototype-less dictionary ensures those
  // names are treated solely as data keys rather than inherited properties.
  const grouped = Object.create(null) as Record<string, ContextWarning[]>;
  for (const warning of warnings) {
    grouped[warning.surface] ??= [];
    grouped[warning.surface]?.push(warning);
  }
  return grouped;
}

function formatCount(count: number | 'absent'): string {
  return count === 'absent' ? 'absent (see warnings)' : String(count);
}
