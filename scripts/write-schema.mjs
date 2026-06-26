import { writeFile } from 'node:fs/promises';

const { siteContextJsonSchema } = await import('../src/schema.ts');

await writeFile(
  new URL('../schemas/site-context-v1.schema.json', import.meta.url),
  `${JSON.stringify(siteContextJsonSchema, null, 2)}\n`,
);
