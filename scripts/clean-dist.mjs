import { access, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const dist = new URL('../dist/', import.meta.url);
try {
  await access(dist);
} catch {
  process.exit(0);
}

const trash = new URL('../.trash/', import.meta.url);
await mkdir(trash, { recursive: true });
const archived = new URL(`dist-${Date.now()}-${process.pid}-${randomUUID()}/`, trash);
await rename(dist, archived);
console.log(`Archived dist to ${archived.pathname}`);
