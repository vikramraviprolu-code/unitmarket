import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { FixtureFileSchema, type FixtureFile } from './fixture-schema';

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile() && e.name.endsWith('.json') && e.name !== 'index.json') out.push(p);
  }
  return out.sort();
}

async function readOne(
  root: string,
  path: string,
): Promise<{ file: string; bytes: Buffer; fx: FixtureFile }> {
  const file = relative(root, path).split(sep).join('/');
  const bytes = await readFile(path);
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`fixture ${file}: not valid JSON`);
  }
  const parsed = FixtureFileSchema.safeParse(json);
  if (!parsed.success) {
    const why = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`fixture ${file}: ${why}`);
  }
  return { file, bytes, fx: parsed.data as FixtureFile };
}

async function readAll(dir: string) {
  const items = [];
  const seen = new Map<string, string>();
  for (const p of await walk(dir)) {
    const item = await readOne(dir, p);
    const key = `${item.fx.meta.scenario}|${item.fx.meta.operation}|${item.fx.meta.step}`;
    const prior = seen.get(key);
    if (prior) throw new Error(`duplicate fixture ${key} in ${prior} and ${item.file}`);
    seen.set(key, item.file);
    items.push(item);
  }
  return items;
}

/** Loads and validates every fixture under `dir` (recursive, stable order). Throws on the first bad file. */
export async function loadFixtures(dir: string): Promise<FixtureFile[]> {
  return (await readAll(dir)).map((i) => i.fx);
}

export interface FixtureIndexEntry {
  file: string;
  sha256: string;
  source: FixtureFile['meta']['source'];
  scenario: string;
  operation: FixtureFile['meta']['operation'];
  step: number;
}
export interface FixtureIndex {
  format: 1;
  files: FixtureIndexEntry[];
}

/** The generated index: one entry per fixture with the sha256 of its bytes (MAINT-5). */
export async function buildIndex(dir: string): Promise<FixtureIndex> {
  const items = await readAll(dir);
  return {
    format: 1,
    files: items.map((i) => ({
      file: i.file,
      sha256: createHash('sha256').update(i.bytes).digest('hex'),
      source: i.fx.meta.source,
      scenario: i.fx.meta.scenario,
      operation: i.fx.meta.operation,
      step: i.fx.meta.step,
    })),
  };
}
