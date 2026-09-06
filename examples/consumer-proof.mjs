import { readFileSync } from 'node:fs';
import {
  checkBindingReference,
  checkTokenReference,
  focusContext,
  lookupNativeToken,
  sourceHash,
  validate,
} from 'wesper';

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('Usage: node consumer-proof.mjs <manifest.json>');

const input = JSON.parse(readFileSync(manifestPath, 'utf8'));
const initial = validate(input);
if (!initial.ok || !initial.context) throw new Error('Consumer fixture did not validate.');

// The fixture is intentionally checked before this assignment: this is the
// consumer-side attestation, rather than an assertion that its placeholder is valid.
input.provenance.sourceHash = sourceHash(initial.context);
const checked = validate(input);
if (!checked.ok || !checked.context) throw new Error('Attested consumer fixture did not validate.');
const context = checked.context;
if (sourceHash(context) !== context.provenance.sourceHash) throw new Error('Fixture sourceHash attestation failed.');

const selected = focusContext(context, {
  postTypes: ['product'],
  blocks: ['core/paragraph'],
  tokenKinds: ['color', 'font-family', 'font-size', 'spacing'],
});
const expected = [
  ['color', 'primary'],
  ['font-family', 'body'],
  ['font-size', 'large'],
  ['spacing', '40'],
];
const nativeTokens = expected.map(([kind, slug]) => lookupNativeToken(context, { kind, slug }));
if (nativeTokens.some((result) => result.status !== 'found')) throw new Error('Expected native tokens were not found.');

const knownToken = checkTokenReference(context, { kind: 'color', slug: 'primary' });
const knownBinding = checkBindingReference(context, {
  block: 'core/paragraph',
  attribute: 'content',
  source: 'core/post-meta',
  field: { postType: 'product', key: 'price' },
});
const absentToken = checkTokenReference(context, { kind: 'color', slug: 'absent' });
const withoutRegistry = JSON.parse(JSON.stringify(input));
delete withoutRegistry.theme.tokens.presets;
const incomplete = validate(withoutRegistry);
if (!incomplete.ok || !incomplete.context) throw new Error('Incomplete fixture did not validate.');
const unknownToken = checkTokenReference(incomplete.context, { kind: 'color', slug: 'absent' });
if (knownToken.status !== 'compatible' || knownBinding.status !== 'compatible' || absentToken.status !== 'incompatible' || unknownToken.status !== 'unknown') {
  throw new Error('Consumer compatibility assertions failed.');
}
if (JSON.stringify(knownBinding.binding?.field.args) !== JSON.stringify({ key: 'price', default: 0, options: { currency: 'USD', precision: 2 } })) {
  throw new Error('Binding arguments were not retained verbatim.');
}

const fullConfig = configFor(context.theme.tokens.presets);
const tokenConfig = configFor(selected.tokens);
if (JSON.stringify(fullConfig) !== JSON.stringify(tokenConfig)) throw new Error('Focused token selection does not contain the full task token mapping.');
const output = {
  sourceManifestHash: context.provenance.sourceHash,
  fixtureHash: sourceHash(context),
  selected: {
    bytes: Buffer.byteLength(JSON.stringify(selected)),
    tokenCount: selected.tokens.length,
    config: tokenConfig,
  },
  full: {
    bytes: Buffer.byteLength(JSON.stringify(context)),
    config: fullConfig,
  },
  consumer: {
    knownToken: compact(knownToken),
    knownBinding: compact(knownBinding),
    absentToken: compact(absentToken),
    missingRegistryToken: compact(unknownToken),
    bindingArgs: knownBinding.binding.field.args,
  },
  attestedManifest: context,
};
console.log(JSON.stringify(output));

function configFor(tokens) {
  const config = { colors: {}, fonts: {}, fontSizes: {}, spacing: {} };
  for (const token of tokens) {
    if (token.kind === 'color') config.colors[token.slug] = token.value;
    if (token.kind === 'font-family') config.fonts[token.slug] = token.value;
    if (token.kind === 'font-size') config.fontSizes[token.slug] = token.value;
    if (token.kind === 'spacing') config.spacing[token.slug] = token.value;
  }
  return config;
}

function compact(result) {
  return { status: result.status, evidence: result.evidence, reasons: result.reasons.map((reason) => reason.code) };
}
