import { readFileSync } from 'node:fs';
import { canonicalize } from 'block-runner';

const planPath = process.argv[2];
if (!planPath) throw new Error('Usage: node block-runner-canonicalize.mjs <plan.json>');
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const outcomes = {};
for (const [name, markup] of Object.entries(plan.markup)) {
  const baselineStarted = performance.now();
  const baseline = await canonicalize(markup);
  baseline.elapsedMs = Math.round(performance.now() - baselineStarted);
  const fullStarted = performance.now();
  const full = await canonicalize(markup, { config: { tokens: plan.fullConfig } });
  full.elapsedMs = Math.round(performance.now() - fullStarted);
  const focusedStarted = performance.now();
  const focused = await canonicalize(markup, { config: { tokens: plan.focusedConfig } });
  focused.elapsedMs = Math.round(performance.now() - focusedStarted);
  if (!baseline.ok || !full.ok || !focused.ok || baseline.summary.invalid !== 0 || full.summary.invalid !== 0 || focused.summary.invalid !== 0) {
    throw new Error(`Canonicalization reported invalid blocks for ${name}.`);
  }
  if (full.output !== focused.output) throw new Error(`Focused token mapping diverged for ${name}.`);
  outcomes[name] = { baseline, full, focused };
}
console.log(JSON.stringify(outcomes));
