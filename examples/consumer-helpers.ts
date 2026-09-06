import { focusContext, lookupField, lookupNativeToken, validate } from '../src/index.js';

const manifest = {
  contextVersion: 1,
  site: {},
  provenance: { collectedAt: '2026-09-06T00:00:00.000Z', collector: 'fixture', collectorVersion: 'example', sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' },
  theme: { settings: {}, tokens: { presets: [token('color', 'primary', '#0057ff'), token('font-family', 'body', 'Inter, sans-serif'), token('font-size', 'large', '2rem'), token('spacing', '40', '1rem')] } },
  bindings: { available: true, sources: [{ name: 'core/post-meta', usesContext: [], argsSchema: null }], supportedAttributes: {} },
  contentModel: { postTypes: [{ name: 'product', fields: [{ name: 'price', key: 'price', source: 'core/post-meta', args: { key: 'price' }, bindable: true }] }] },
  warnings: [],
};
const checked = validate(manifest);
if (!checked.ok || !checked.context) throw new Error('Portable fixture did not validate.');
const primary = lookupNativeToken(checked.context, { kind: 'color', slug: 'primary' });
const price = lookupField(checked.context, { postType: 'product', key: 'price', source: 'core/post-meta' });
if (primary.status !== 'found' || price.status !== 'found') throw new Error('Expected collected references were not found.');
console.log(primary.value.references.blockStyle, price.value.args, focusContext(checked.context, { tokenKinds: ['color', 'font-family', 'font-size', 'spacing'], postTypes: ['product'] }).derived);

function token(kind: 'color' | 'font-family' | 'font-size' | 'spacing', slug: string, value: string) {
  const property = `--wp--preset--${kind}--${slug}`;
  return { id: `${kind}:${slug}`, kind, slug, value, valueSource: 'declared' as const, origin: 'theme' as const, references: { cssCustomProperty: property, cssValue: `var(${property})`, blockStyle: `var:preset|${kind}|${slug}` } };
}
