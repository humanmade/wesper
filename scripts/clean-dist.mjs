import { access, mkdir, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
try {
  await access(dist);
} catch (error) {
  if (error.code === 'ENOENT') process.exit(0);
  throw error;
}

try {
  await promisify(execFile)('trash', [dist]);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const trash = join(homedir(), '.Trash');
  await mkdir(trash, { recursive: true });
  await rename(dist, join(trash, `wesper-dist-${Date.now()}-${randomUUID()}`));
}
console.log('Moved previous dist to the system Trash.');
