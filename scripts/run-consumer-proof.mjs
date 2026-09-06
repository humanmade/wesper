import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
// npm run exports npmrc policy as environment flags. npm 12 rejects the
// allow-scripts flag for a nested project install; let it reread npmrc instead.
const installEnv = { ...process.env };
delete installEnv.npm_config_allow_scripts;
delete installEnv.NPM_CONFIG_ALLOW_SCRIPTS;
const root = process.cwd();
const startedAt = performance.now();
const artifactDir = join(root, 'build', 'consumer-proof', randomUUID());
mkdirSync(artifactDir, { recursive: true });
let temp;

try {
  await run('npm', ['run', 'build'], root);
  const packOutput = JSON.parse((await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', artifactDir], root)).stdout);
  const packed = Array.isArray(packOutput) ? packOutput : Object.values(packOutput);
  if (packed.length !== 1 || packed[0]?.name !== 'wesper') throw new Error('npm pack did not return exactly one Wesper package.');
  const pack = packed[0];
  const tarball = join(artifactDir, pack.filename);
  if (!existsSync(tarball)) throw new Error(`npm pack did not create ${pack.filename}.`);
  const candidate = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const candidateCommit = (await run('git', ['rev-parse', 'HEAD'], root)).stdout.trim();
  const candidateDirty = (await run('git', ['status', '--porcelain'], root)).stdout.trim().length > 0;
  temp = join(tmpdir(), `wesper-consumer-proof-${randomUUID()}`);
  mkdirSync(temp, { recursive: true });
  await run('npm', ['init', '--yes'], temp);
  await run('npm', ['install', '--ignore-scripts', '--no-save', '--no-audit', '--no-fund', tarball, 'block-runner@0.8.0'], temp, installEnv);
  const installedWesper = JSON.parse(readFileSync(join(temp, 'node_modules', 'wesper', 'package.json'), 'utf8'));
  const installedBlockRunner = JSON.parse(readFileSync(join(temp, 'node_modules', 'block-runner', 'package.json'), 'utf8'));
  if (installedWesper.version !== candidate.version) throw new Error(`Installed Wesper ${installedWesper.version} did not resolve candidate ${candidate.version}.`);
  if (installedBlockRunner.version !== '0.8.0') throw new Error(`Installed Block Runner ${installedBlockRunner.version} did not resolve pinned 0.8.0.`);

  const fixture = join(temp, 'consumer-manifest.json');
  copyFileSync(join(temp, 'node_modules', 'wesper', 'examples', 'fixtures', 'consumer-manifest.json'), fixture);
  const helper = await run(process.execPath, [join('node_modules', 'wesper', 'examples', 'consumer-proof.mjs'), fixture], temp);
  const consumer = JSON.parse(helper.stdout);
  const plan = {
    fullConfig: consumer.full.config,
    focusedConfig: consumer.selected.config,
    markup: {
      color: '<!-- wp:group {"style":{"color":{"background":"#0057ff"}}} --><div class="wp-block-group has-background" style="background-color:#0057ff"><!-- wp:paragraph --><p>Brand</p><!-- /wp:paragraph --></div><!-- /wp:group -->',
      fontFamily: '<!-- wp:paragraph {"style":{"typography":{"fontFamily":"Inter, sans-serif"}}} --><p style="font-family:Inter, sans-serif">Brand</p><!-- /wp:paragraph -->',
      fontSize: '<!-- wp:heading {"style":{"typography":{"fontSize":"2rem"}}} --><h2 class="wp-block-heading" style="font-size:2rem">Brand</h2><!-- /wp:heading -->',
      spacing: '<!-- wp:group {"style":{"spacing":{"padding":{"top":"1rem"}}}} --><div class="wp-block-group" style="padding-top:1rem"><!-- wp:paragraph --><p>Brand</p><!-- /wp:paragraph --></div><!-- /wp:group -->',
      literal: '<!-- wp:group {"style":{"color":{"background":"#123456"}}} --><div class="wp-block-group has-background" style="background-color:#123456"><!-- wp:paragraph --><p>Literal</p><!-- /wp:paragraph --></div><!-- /wp:group -->',
    },
  };
  const planPath = join(temp, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan));
  const blockRunnerHelper = join(temp, 'block-runner-canonicalize.mjs');
  copyFileSync(join(root, 'examples', 'block-runner-canonicalize.mjs'), blockRunnerHelper);
  const blockRunner = JSON.parse((await run(process.execPath, [blockRunnerHelper, planPath], temp)).stdout);
  assertReports(blockRunner);
  const evidence = {
    schemaVersion: 1,
    candidate: { version: candidate.version, commit: candidateCommit, dirty: candidateDirty, tarball: basename(tarball), sha256: sha256(tarball) },
    consumer: { wesperVersion: installedWesper.version, blockRunnerVersion: installedBlockRunner.version, fixtureHash: consumer.fixtureHash, sourceManifestHash: consumer.sourceManifestHash },
    metrics: { elapsedMs: Math.round(performance.now() - startedAt), fullBytes: consumer.full.bytes, focusedBytes: consumer.selected.bytes, nativeReferenceCount: nativeReferenceCount(blockRunner), model: null, cost: null, stochasticMetrics: null, notPerformed: ['No model calls, cost measurement, benchmark, or performance-benefit claim was performed.'] },
    compatibility: consumer.consumer,
    canonicalization: summarizeReports(blockRunner),
  };
  writeFileSync(join(artifactDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(join(artifactDir, 'consumer-output.json'), `${JSON.stringify(consumer, null, 2)}\n`);
  writeFileSync(join(artifactDir, 'canonicalization.json'), `${JSON.stringify(blockRunner, null, 2)}\n`);
  writeFileSync(join(artifactDir, 'manifest.json'), `${JSON.stringify(consumer.attestedManifest, null, 2)}\n`);
  for (const mode of ['baseline', 'full', 'focused']) {
    writeFileSync(join(artifactDir, `${mode}.json`), `${JSON.stringify(Object.fromEntries(Object.entries(blockRunner).map(([name, report]) => [name, report[mode].output])), null, 2)}\n`);
  }
  console.log(JSON.stringify({ evidence: 'build/consumer-proof/' + basename(artifactDir) + '/evidence.json', elapsedMs: evidence.metrics.elapsedMs }));
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  writeFileSync(join(artifactDir, 'failure.json'), `${JSON.stringify({ status: 'failed', message: 'Consumer proof did not complete; inspect the command output.' }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  if (temp && existsSync(temp)) await recoverablyRemove(temp);
}

function summarizeReports(reports) {
  return Object.fromEntries(Object.entries(reports).map(([name, report]) => [name, {
    baseline: compactReport(report.baseline),
    full: compactReport(report.full),
    focused: compactReport(report.focused),
  }]));
}

function compactReport(report) {
  const repairReports = report.items.filter((item) => item.rule === 'token-repair').map((item) => item.reason);
  const expectedReferences = ['has-primary-background-color', 'has-body-font-family', 'has-large-font-size', 'var:preset|spacing|40'];
  return {
    ok: report.ok,
    invalid: report.summary.invalid,
    elapsedMs: report.elapsedMs,
    output: report.output,
    observed: {
      expectedNativeReferenceCount: expectedReferences.filter((reference) => report.output.includes(reference)).length,
      intentionalLiteralCount: (report.output.match(/#123456/g) ?? []).length,
      repairCount: repairReports.length,
    },
    repairReports,
  };
}

function nativeReferenceCount(reports) {
  return Object.values(reports).flatMap((report) => ['has-primary-background-color', 'has-body-font-family', 'has-large-font-size', 'var:preset|spacing|40']
    .filter((reference) => report.full.output.includes(reference))).length;
}

function assertReports(reports) {
  const required = [
    ['color', 'has-primary-background-color', '#0057ff'],
    ['fontFamily', 'has-body-font-family', 'Inter, sans-serif'],
    ['fontSize', 'has-large-font-size', 'font-size:2rem'],
    ['spacing', 'var:preset|spacing|40', 'padding-top:1rem'],
  ];
  for (const [name, nativeReference, literal] of required) {
    const report = reports[name];
    if (!report.baseline.output.includes(literal) || !report.full.output.includes(nativeReference) || report.full.output.includes(literal) || report.full.items.filter((item) => item.rule === 'token-repair').length === 0) {
      throw new Error(`Expected native token reuse was not demonstrated for ${name}.`);
    }
  }
  if (!reports.literal.full.output.includes('#123456') || reports.literal.full.output.includes('has-primary-background-color')) {
    throw new Error('Intentional unmatched literal was not retained.');
  }
}

function sha256(path) { return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`; }
async function run(file, args, cwd, env = process.env) { return execFile(file, args, { cwd, env, maxBuffer: 20 * 1024 * 1024 }); }
async function recoverablyRemove(path) {
  try {
    await run('trash', [path], root);
  } catch {
    const destination = join(homedir(), '.Trash', basename(path));
    mkdirSync(join(homedir(), '.Trash'), { recursive: true });
    renameSync(path, destination);
  }
}
