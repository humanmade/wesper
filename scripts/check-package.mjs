import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(path.join(tmpdir(), 'wesper-package-'));
const npmEnv = { ...process.env, npm_config_cache: path.join(scratch, 'npm-cache') };

try {
  const packed = JSON.parse((await execFileAsync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: root, env: npmEnv })).stdout);
  const artifact = path.join(scratch, packed[0].filename);
  const actual = new Set(packed[0].files.map((file) => file.path));
  const allowed = new Set([
    'LICENSE', 'README.md', 'package.json',
    'dist/cli.js', 'dist/index.js', 'dist/cli.d.ts', 'dist/index.d.ts',
    'schemas/site-context-v1.schema.json',
    'examples/consumer-helpers.mjs', 'examples/fixtures/consumer-manifest.json',
  ]);
  for (const file of allowed) if (!actual.has(file)) throw new Error(`Package is missing required file: ${file}`);
  for (const file of actual) if (!allowed.has(file)) throw new Error(`Package contains disallowed file: ${file}`);

  await writeFile(path.join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await execFileAsync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', artifact], { cwd: scratch, env: npmEnv });
  await writeFile(path.join(scratch, 'verify.mjs'), `
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkBindingReference, checkTokenReference, lookupNativeToken, validate } from 'wesper';
if (typeof checkTokenReference !== 'function') throw new Error('Compatibility token helper was not exported.');
if (typeof checkBindingReference !== 'function') throw new Error('Compatibility binding helper was not exported.');
const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('wesper/package.json'));
const fixture = JSON.parse(await readFile(path.join(packageRoot, 'examples/fixtures/consumer-manifest.json'), 'utf8'));
const result = validate(fixture);
if (!result.ok || !result.context) throw new Error('Shipped fixture did not validate.');
if (lookupNativeToken(result.context, { kind: 'color', slug: 'primary' }).status !== 'found') throw new Error('Native reference helper failed.');
JSON.parse(await readFile(path.join(packageRoot, 'schemas/site-context-v1.schema.json'), 'utf8'));
`);
  await execFileAsync(process.execPath, ['verify.mjs'], { cwd: scratch });

  const packageRoot = path.join(scratch, 'node_modules', 'wesper');
  const cli = await readFile(path.join(packageRoot, 'dist', 'cli.js'), 'utf8');
  if (!cli.startsWith('#!/usr/bin/env node')) throw new Error('dist/cli.js is missing the node shebang.');
  const bin = path.join(scratch, 'node_modules', '.bin', 'wesper');
  const help = await execFileAsync(bin, ['--help'], { cwd: scratch });
  if (!help.stdout.includes('Usage: wesper')) throw new Error('Installed CLI did not print help.');
  const version = await execFileAsync(bin, ['--version'], { cwd: scratch });
  const packageVersion = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')).version;
  if (version.stdout.trim() !== packageVersion) throw new Error('Installed CLI version did not match package.json.');
  const fixturePath = path.join(packageRoot, 'examples/fixtures/consumer-manifest.json');
  await execFileAsync(bin, ['validate', fixturePath], { cwd: scratch });
  await execFileAsync(bin, ['summarize', fixturePath], { cwd: scratch });
  await execFileAsync(process.execPath, [path.join(packageRoot, 'examples/consumer-helpers.mjs')], { cwd: scratch });
} finally {
  await rm(scratch, { recursive: true, force: true });
}
