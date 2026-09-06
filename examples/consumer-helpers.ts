import { readFileSync } from 'node:fs';
import { focusContext, lookupBlock, lookupField, lookupNativeToken, validate } from '../src/index.js';

const manifest = JSON.parse(readFileSync(new URL('./fixtures/consumer-manifest.json', import.meta.url), 'utf8'));
const checked = validate(manifest);
if (!checked.ok || !checked.context) throw new Error('Portable fixture did not validate.');
const context = checked.context;
const tokens = [
  lookupNativeToken(context, { kind: 'color', slug: 'primary' }),
  lookupNativeToken(context, { kind: 'font-family', slug: 'body' }),
  lookupNativeToken(context, { kind: 'font-size', slug: 'large' }),
  lookupNativeToken(context, { kind: 'spacing', slug: '40' }),
];
const price = lookupField(context, { postType: 'product', key: 'price', source: 'core/post-meta' });
const paragraph = lookupBlock(context, 'core/paragraph');
if (tokens.some((result) => result.status !== 'found') || price.status !== 'found' || paragraph.status !== 'found') {
  throw new Error('Expected collected references were not found.');
}

assertEqual(tokens.map((result) => result.value.references), [
  { cssCustomProperty: '--wp--preset--color--primary', cssValue: 'var(--wp--preset--color--primary)', blockStyle: 'var:preset|color|primary' },
  { cssCustomProperty: '--wp--preset--font-family--body', cssValue: 'var(--wp--preset--font-family--body)', blockStyle: 'var:preset|font-family|body' },
  { cssCustomProperty: '--wp--preset--font-size--large', cssValue: 'var(--wp--preset--font-size--large)', blockStyle: 'var:preset|font-size|large' },
  { cssCustomProperty: '--wp--preset--spacing--40', cssValue: 'var(--wp--preset--spacing--40)', blockStyle: 'var:preset|spacing|40' },
], 'native references');
assertEqual(price.value.args, { key: 'price', default: 0, options: { currency: 'USD', precision: 2 } }, 'field args');

console.log(JSON.stringify(focusContext(context, {
  postTypes: ['product'],
  blocks: ['core/paragraph'],
  tokenKinds: ['color', 'font-family', 'font-size', 'spacing'],
}), null, 2));

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Unexpected ${label}.`);
}
