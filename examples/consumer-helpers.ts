import { readFileSync } from 'node:fs';
import { checkBindingReference, checkTokenReference, validate } from '../src/index.js';

const manifest = JSON.parse(readFileSync(new URL('./fixtures/consumer-manifest.json', import.meta.url), 'utf8'));
const checked = validate(manifest);
if (!checked.ok || !checked.context) throw new Error('Portable fixture did not validate.');
const primaryColor = checkTokenReference(checked.context, { kind: 'color', slug: 'primary' });
const productPrice = checkBindingReference(checked.context, {
  block: 'core/paragraph',
  attribute: 'content',
  source: 'core/post-meta',
  field: { postType: 'product', key: 'price' },
});

assertEqual(primaryColor.status, 'compatible', 'primary color compatibility');
assertEqual(productPrice.status, 'compatible', 'product price binding compatibility');

const absentToken = checkTokenReference(checked.context, { kind: 'color', slug: 'absent' });
assertEqual(absentToken.status, 'incompatible', 'absent token compatibility with complete evidence');

const missingNativeEvidence = JSON.parse(JSON.stringify(manifest));
delete missingNativeEvidence.theme.tokens.presets;
const incomplete = validate(missingNativeEvidence);
if (!incomplete.ok || !incomplete.context) throw new Error('Fixture without native-token evidence did not validate.');
assertEqual(
  checkTokenReference(incomplete.context, { kind: 'color', slug: 'absent' }).status,
  'unknown',
  'absent token compatibility without native-token evidence',
);

// A consumer emits only after each explicit reference is supported by the supplied snapshot.
if (primaryColor.status !== 'compatible' || productPrice.status !== 'compatible') {
  throw new Error('Consumer must not proceed with unresolved references.');
}

console.log(JSON.stringify({
  primaryColor: primaryColor.evidence,
  productPrice: productPrice.evidence,
}, null, 2));

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`Unexpected ${label}.`);
}
