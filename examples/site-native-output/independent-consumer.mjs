import { readFile } from 'node:fs/promises';
import { checkTokenReference, lookupNativeToken, validate } from 'wesper';

const [manifestPath, fixturePath] = process.argv.slice(2);
if (!manifestPath || !fixturePath) throw new Error('Usage: independent-consumer.mjs <manifest.json> <fixture.json>');

const started = process.hrtime.bigint();
const [manifest, fixture] = await Promise.all([
  readJson(manifestPath),
  readJson(fixturePath),
]);
const checked = validate(manifest);
if (!checked.ok || !checked.context) throw new Error('The supplied manifest did not validate through the installed Wesper package.');
if (!Array.isArray(fixture.nativeTokenCandidates) || !Array.isArray(fixture.intentionalLiterals)) throw new Error('The supplied fixture has an unsupported shape.');

const locations = fixture.nativeTokenCandidates.map((candidate) => {
  const reference = { kind: candidate.kind, slug: candidate.slug };
  const token = lookupNativeToken(checked.context, reference);
  const compatibility = checkTokenReference(checked.context, reference);
  const emitted = token.status === 'found' && compatibility.status === 'compatible'
    ? token.value.references.blockStyle
    : null;
  return { ...candidate, emitted, lookupStatus: token.status, compatibilityStatus: compatibility.status };
});
const invalidReferences = locations
  .filter((item) => item.emitted !== null && item.compatibilityStatus !== 'compatible')
  .map(({ location, emitted, compatibilityStatus }) => ({ location, value: emitted, compatibilityStatus }));
const unnecessaryLiterals = locations
  .filter((item) => item.emitted === item.literal)
  .map(({ location, literal }) => ({ location, value: literal }));
const repairAttempts = locations
  .filter((item) => item.emitted !== null && item.emitted !== item.literal)
  .map(({ location, literal, emitted }) => ({ location, from: literal, to: emitted }));
const missing = locations.filter((item) => item.emitted === null).map(({ location, lookupStatus, compatibilityStatus }) => ({ location, lookupStatus, compatibilityStatus }));

console.log(JSON.stringify({
  schema: 'wesper.site-native-output.independent-consumer/v1',
  consumer: 'independent-consumer',
  publicApi: ['validate', 'lookupNativeToken', 'checkTokenReference'],
  manifestSourceHash: checked.context.provenance.sourceHash,
  nativeTokenReuse: {
    matchedLocations: locations.filter((item) => item.emitted !== null).length,
    totalOpportunities: locations.length,
    locations,
  },
  invalidReferences,
  unnecessaryLiterals,
  repairAttempts,
  intentionalLiterals: fixture.intentionalLiterals,
  missing,
  durationMs: Number(process.hrtime.bigint() - started) / 1e6,
  cost: { available: false, reason: 'Deterministic local public-API lookup has no provider cost.' },
}, null, 2));
if (missing.length > 0 || invalidReferences.length > 0) process.exitCode = 1;

async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
