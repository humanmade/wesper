import type { ContextWarning, SiteContext, Summary } from './types.js';
import { allWarnings } from './warnings.js';

export function summarize(context: SiteContext): Summary {
  const postTypes = context.contentModel.postTypes ?? [];
  const fieldsByPostType = Object.fromEntries(
    postTypes.map((postType) => [postType.name, postType.fields?.filter((field) => field.bindable).length ?? 0]),
  );

  const warnings = allWarnings(context);

  return {
    site: {
      url: context.site.url,
      wordpressVersion: context.wordpress.version,
      theme: context.theme.name ?? context.theme.stylesheet,
      collector: context.provenance.collector,
      collectedAt: context.provenance.collectedAt,
      sourceHash: context.provenance.sourceHash,
    },
    counts: {
      blockTypes: context.blocks.types?.length ?? 0,
      bindingSources: context.bindings.sources?.length ?? 0,
      postTypes: postTypes.length,
      bindableFields: Object.values(fieldsByPostType).reduce((sum, count) => sum + count, 0),
      patterns: context.patterns.items?.length ?? 0,
      plugins: context.plugins.length,
      imageSizes: context.media.imageSizes?.length ?? 0,
      warnings: warnings.length,
    },
    bindingReadiness: {
      supportedAttributes: context.bindings.supportedAttributes ?? {},
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
    `- Block types: ${summary.counts.blockTypes}`,
    `- Binding sources: ${summary.counts.bindingSources}`,
    `- Post types: ${summary.counts.postTypes}`,
    `- Bindable fields: ${summary.counts.bindableFields}`,
    `- Patterns: ${summary.counts.patterns}`,
    `- Plugins: ${summary.counts.plugins}`,
    `- Image sizes: ${summary.counts.imageSizes}`,
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
  const grouped: Record<string, ContextWarning[]> = {};
  for (const warning of warnings) {
    grouped[warning.surface] ??= [];
    grouped[warning.surface]?.push(warning);
  }
  return grouped;
}
