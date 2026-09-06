import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const example = fileURLToPath(new URL('./', import.meta.url));
const args = parseArgs(process.argv.slice(2));

if (args.help) usage(0);
if (!args.blockRunner || !args.out) usage(1, '--block-runner and --out are required.');

const blockRunnerTarball = path.resolve(args.blockRunner);
const outputDirectory = path.resolve(args.out);
if (!blockRunnerTarball.endsWith('.tgz')) usage(1, '--block-runner must name a packaged .tgz artifact.');
await access(blockRunnerTarball);
try {
  await mkdir(outputDirectory);
} catch (error) {
  throw new Error(`Output directory must be new and creatable: ${outputDirectory} (${message(error)})`);
}

const runsDirectory = path.join(outputDirectory, 'runs');
await mkdir(runsDirectory);
const consumer = await mkdirTemp('wesper-site-native-output-');
const artifacts = path.join(consumer, 'artifacts');
await mkdir(artifacts);
const npmCache = path.join(consumer, 'npm-cache');
const npmEnv = { ...process.env, npm_config_cache: npmCache };

const startedAt = new Date().toISOString();
const manifestPath = path.join(root, 'examples', 'fixtures', 'consumer-manifest.json');
const fixturePath = path.join(example, 'fixture.html');
const metricsFixturePath = path.join(example, 'fixture.json');
const [manifestSource, fixtureSource, metricsFixtureSource] = await Promise.all([readFile(manifestPath), readFile(fixturePath), readFile(metricsFixturePath)]);
const wesperPack = await packWesper(artifacts, npmEnv);
const wesperTarball = path.join(artifacts, wesperPack.filename);

await writeJson(path.join(consumer, 'package.json'), { private: true, type: 'module', name: 'wesper-recorder-consumer' });
const install = await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', wesperTarball, blockRunnerTarball], { cwd: consumer, env: npmEnv });
await writeJson(path.join(outputDirectory, 'install.json'), install);
if (install.exitCode !== 0) {
  await finishFailure('Package installation failed; see install.json.', { consumer, startedAt, blockRunnerTarball, wesperTarball });
}

const installed = await installedPackages(consumer);
const fullContext = path.join(consumer, 'full-context.json');
await writeFile(fullContext, manifestSource);
const metricsFixture = path.join(consumer, 'fixture.json');
await writeFile(metricsFixture, metricsFixtureSource);
const focusedContext = path.join(consumer, 'focused-context.json');
const derive = await deriveFocused(consumer, fullContext, focusedContext);
await writeJson(path.join(outputDirectory, 'focused-context-derivation.json'), derive);
if (derive.exitCode !== 0) {
  await finishFailure('Installed Wesper could not derive focused context; see focused-context-derivation.json.', { consumer, startedAt, blockRunnerTarball, wesperTarball });
}

const independentScript = path.join(consumer, 'node_modules', 'wesper', 'examples', 'site-native-output', 'independent-consumer.mjs');
const independentRaw = await run(process.execPath, [independentScript, fullContext, metricsFixture], { cwd: consumer });
const independentRawPath = path.join(runsDirectory, 'independent-consumer.json');
await writeJson(independentRawPath, independentRaw);
const independent = {
  raw: path.relative(outputDirectory, independentRawPath),
  exitCode: independentRaw.exitCode,
  signal: independentRaw.signal,
  commandDurationMs: independentRaw.durationMs,
  metrics: parseJson(independentRaw.stdout),
};

const binary = path.join(consumer, 'node_modules', '.bin', 'block-runner');
const baseArgs = ['convert', '-', '--json', '--styling', 'relaxed', '--token-match', 'exact'];
const arms = [
  { arm: 'baseline', argv: baseArgs },
  { arm: 'full-manifest', argv: [...baseArgs, '--context', fullContext] },
  { arm: 'focused-context', argv: [...baseArgs, '--context', focusedContext] },
];
const runs = [];
for (const arm of arms) {
  const result = await run(binary, arm.argv, { cwd: consumer, input: fixtureSource });
  const rawPath = path.join(runsDirectory, `${arm.arm}.json`);
  await writeJson(rawPath, { arm: arm.arm, ...result });
  runs.push({ arm: arm.arm, raw: path.relative(outputDirectory, rawPath), ...summarizeRun(result) });
}

const findings = deriveFindings(runs, independent, fixturePath);
await writeJson(path.join(outputDirectory, 'findings.json'), findings);
const record = {
  schema: 'wesper.site-native-output.record/v1',
  startedAt,
  finishedAt: new Date().toISOString(),
  consumer,
  fixture: { path: relative(root, fixturePath), sha256: digest(fixtureSource), bytes: fixtureSource.byteLength },
  metricsFixture: { path: relative(root, metricsFixturePath), sha256: digest(metricsFixtureSource), bytes: metricsFixtureSource.byteLength },
  manifest: { path: relative(root, manifestPath), sha256: digest(manifestSource), bytes: manifestSource.byteLength },
  packages: {
    wesper: await artifactProvenance(wesperTarball, installed.wesper),
    blockRunner: await artifactProvenance(blockRunnerTarball, installed.blockRunner),
  },
  runtime: { node: process.version, npm: (await commandVersion('npm')).trim(), platform: process.platform, arch: process.arch },
  commands: { install: 'install.json', focusedContextDerivation: 'focused-context-derivation.json', independentConsumer: independent, runs },
  status: independent.exitCode === 0 && runs.every((run) => run.exitCode === 0) ? 'complete' : 'incomplete',
};
await writeJson(path.join(outputDirectory, 'record.json'), record);
console.log(`${record.status}: ${path.join(outputDirectory, 'record.json')}`);
if (record.status !== 'complete') process.exitCode = 1;

async function packWesper(destination, env) {
  const packed = await execFileAsync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], { cwd: root, env });
  const entries = JSON.parse(packed.stdout);
  if (!Array.isArray(entries) || entries.length !== 1 || typeof entries[0]?.filename !== 'string') throw new Error('npm pack did not return exactly one Wesper artifact.');
  return entries[0];
}

async function deriveFocused(cwd, full, focused) {
  const program = [
    "import { readFile, writeFile } from 'node:fs/promises';",
    "import { focusContext, validate } from 'wesper';",
    "const source = JSON.parse(await readFile(process.argv[1], 'utf8'));",
    "const result = validate(source);",
    "if (!result.ok || !result.context) throw new Error('full manifest did not validate through installed Wesper');",
    "const view = focusContext(result.context, { blocks: ['core/paragraph'], tokenKinds: ['color', 'font-family', 'font-size', 'spacing'] });",
    "await writeFile(process.argv[2], JSON.stringify(view, null, 2) + '\\n');",
  ].join('\n');
  return run(process.execPath, ['--input-type=module', '--eval', program, full, focused], { cwd });
}

async function installedPackages(cwd) {
  return {
    wesper: JSON.parse(await readFile(path.join(cwd, 'node_modules', 'wesper', 'package.json'), 'utf8')),
    blockRunner: JSON.parse(await readFile(path.join(cwd, 'node_modules', 'block-runner', 'package.json'), 'utf8')),
  };
}

async function artifactProvenance(file, installedPackage) {
  const bytes = await readFile(file);
  return { tarball: path.resolve(file), sha256: digest(bytes), bytes: bytes.byteLength, installed: { name: installedPackage.name, version: installedPackage.version } };
}

function summarizeRun(result) {
  const parsed = parseJson(result.stdout);
  const output = typeof parsed?.output === 'string' ? parsed.output : null;
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    outputSha256: output === null ? null : digest(Buffer.from(output)),
    report: parsed && typeof parsed === 'object' ? { ok: parsed.ok ?? null, summary: parsed.summary ?? null, items: parsed.items ?? null } : null,
  };
}

function deriveFindings(runs, independent, fixture) {
  return {
    schema: 'wesper.site-native-output.findings/v1',
    derivedFrom: runs.map(({ arm, raw }) => ({ arm, raw })),
    fixture: relative(root, fixture),
    independentConsumer: {
      raw: independent.raw,
      status: independent.exitCode === 0 ? 'recorded' : 'failed',
      exitCode: independent.exitCode,
      commandDurationMs: independent.commandDurationMs,
      metrics: independent.metrics,
    },
    results: runs.map((run) => ({
      arm: run.arm,
      status: run.exitCode === 0 ? 'recorded' : 'failed',
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      outputSha256: run.outputSha256,
      repairEvidence: repairEvidence(run.report?.items),
    })),
    conclusion: 'Derived from raw packaged-CLI records only. Compare output and repair evidence after inspecting the recorded reports; no performance or quality conclusion is inferred by this recorder.',
  };
}

function repairEvidence(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item && typeof item === 'object');
}

async function run(command, argv, { cwd, env = process.env, input } = {}) {
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const child = spawn(command, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  return {
    schema: 'wesper.site-native-output.command/v1', startedAt, finishedAt: new Date().toISOString(), durationMs: Number(process.hrtime.bigint() - started) / 1e6,
    executable: command, argv, cwd, exitCode: outcome.exitCode, signal: outcome.signal,
    stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

async function finishFailure(reason, details) {
  await writeJson(path.join(outputDirectory, 'record.json'), { schema: 'wesper.site-native-output.record/v1', status: 'blocked', reason, finishedAt: new Date().toISOString(), ...details });
  console.error(`blocked: ${path.join(outputDirectory, 'record.json')}`);
  process.exit(1);
}

async function mkdirTemp(prefix) { return (await import('node:fs/promises')).mkdtemp(path.join(tmpdir(), prefix)); }
async function commandVersion(command) { return (await execFileAsync(command, ['--version'])).stdout; }
function digest(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function parseJson(value) { try { return JSON.parse(value); } catch { return null; } }
function relative(from, target) { return path.relative(from, target) || '.'; }
function message(error) { return error instanceof Error ? error.message : String(error); }
async function writeJson(file, value) { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); }
function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--help' || value === '-h') parsed.help = true;
    else if (value === '--block-runner' || value === '--out') {
      const next = values[++index];
      if (!next || next.startsWith('--')) usage(1, `Missing value for ${value}.`);
      parsed[value === '--block-runner' ? 'blockRunner' : 'out'] = next;
    } else usage(1, `Unknown argument: ${value}`);
  }
  return parsed;
}
function usage(code, detail) {
  if (detail) console.error(detail);
  console[code === 0 ? 'log' : 'error']('Usage: node examples/site-native-output/record.mjs --block-runner /absolute/path/block-runner.tgz --out /absolute/path/new-results');
  process.exit(code);
}
