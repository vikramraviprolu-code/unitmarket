// INT-GA / GA.3: fifty phrased queries on the scripted model. At least 45 must give exactly the expected chips
// (and dropped fields); the run prints every miss. A no-overlap check proves the scripted answers are rules, not a
// lookup of this file (F2, R2-2): no eval phrase of three or more words and no eval ref appears in the scripted
// model or the shared word table.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createScriptedModel } from '@umsbx/model';
import { assistQuery } from '../src/index';
import type { AssistRole } from '../src/index';

interface Case {
  id: string;
  role: AssistRole;
  text: string;
  chips: Record<string, string>;
  dropped?: string[];
}
const here = fileURLToPath(new URL('.', import.meta.url));
const doc = JSON.parse(readFileSync(join(here, 'queries.json'), 'utf8')) as {
  now: string;
  sellers: string[];
  cases: Case[];
};
const repo = join(here, '..', '..', '..');
const SCRIPTED = readFileSync(join(repo, 'packages/model/src/scripted-assist.ts'), 'utf8').toLowerCase();
const WORDS = readFileSync(join(repo, 'packages/contracts/src/assist-words.ts'), 'utf8').toLowerCase();

const sameSet = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

describe('GA.3 query eval (scripted model)', () => {
  it('has fifty cases with unique ids', () => {
    expect(doc.cases).toHaveLength(50);
    expect(new Set(doc.cases.map((c) => c.id)).size).toBe(50);
  });

  it('at least 45 of 50 are exact', async () => {
    const model = createScriptedModel();
    const now = new Date(doc.now);
    const misses: string[] = [];
    for (const c of doc.cases) {
      const r = await assistQuery(c.text, now, { role: c.role, sellers: doc.sellers }, model);
      const ok =
        JSON.stringify(Object.entries(r.chips).sort()) ===
          JSON.stringify(Object.entries(c.chips).sort()) && sameSet(r.dropped, c.dropped ?? []);
      if (!ok)
        misses.push(
          `${c.id} "${c.text}": want ${JSON.stringify(c.chips)} drop ${JSON.stringify(c.dropped ?? [])}, got ${JSON.stringify(r.chips)} drop ${JSON.stringify(r.dropped)}`,
        );
    }
    console.log(`GA.3 exact ${50 - misses.length}/50`);
    for (const m of misses) console.log(`GA.3 miss ${m}`);
    expect(50 - misses.length).toBeGreaterThanOrEqual(45);
  });
});

describe('no overlap: the scripted answers are rules, not a lookup (R2-2)', () => {
  const phrases = doc.cases.map((c) => c.text.toLowerCase()).filter((t) => t.split(/\s+/).length >= 3);
  const refs = doc.cases
    .flatMap((c) => [c.text, ...Object.values(c.chips)])
    .flatMap((t) => t.match(/\bord_[a-z0-9_]+\b|\b(?=[A-Z0-9]*\d)[A-Z0-9]{10,30}\b/gi) ?? []);

  it('there are phrases and refs to check', () => {
    expect(phrases.length).toBeGreaterThan(30);
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });
  it.each([
    ['scripted-assist.ts', SCRIPTED],
    ['assist-words.ts', WORDS],
  ])('no eval phrase of three or more words and no eval ref is in %s', (_name, src) => {
    for (const p of phrases) expect(src, p).not.toContain(p);
    for (const r of refs) expect(src, r).not.toContain(r.toLowerCase());
  });
});
