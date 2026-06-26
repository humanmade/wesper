import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const requiredFiles = [
  'dist/cli.js',
  'dist/index.js',
  'dist/index.d.ts',
  'schemas/site-context-v1.schema.json',
];

for (const file of requiredFiles) {
  await access(new URL(`../${file}`, import.meta.url));
}

const cli = await readFile(new URL('../dist/cli.js', import.meta.url), 'utf8');
if (!cli.startsWith('#!/usr/bin/env node')) {
  throw new Error('dist/cli.js is missing the node shebang.');
}

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const { stdout } = await execFileAsync(process.execPath, [cliPath, '--help'], {
  encoding: 'utf8',
});
if (!stdout.includes('Usage: wesper')) {
  throw new Error('dist/cli.js --help did not print the expected CLI usage.');
}
