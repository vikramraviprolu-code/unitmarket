import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFixtures } from './fixture-store';
import { FixtureFileSchema } from './fixture-schema';

const good = () => ({
  meta: {
    source: 'synthetic',
    scenario: 's',
    operation: 'get_order',
    step: 1,
    recorded_at: null,
    origin: 'unit test',
    redactions: [],
  },
  request: { method: 'GET', path_template: '/v2/checkout/orders/{id}', headers: {}, body: null },
  response: { status: 200, headers: { 'content-type': 'application/json' }, body: { id: 'X' } },
});

async function dirWith(files: Record<string, unknown>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'umsbx-fx-'));
  for (const [name, v] of Object.entries(files)) {
    await mkdir(join(d, name, '..'), { recursive: true });
    await writeFile(join(d, name), typeof v === 'string' ? v : JSON.stringify(v));
  }
  return d;
}

describe('fixture schema', () => {
  it('accepts a response and a timeout fixture', () => {
    expect(FixtureFileSchema.safeParse(good()).success).toBe(true);
    const t = { ...good(), response: { timeout: true } };
    expect(FixtureFileSchema.safeParse(t).success).toBe(true);
  });
  it('refuses unknown fields at every level', () => {
    const a = good() as Record<string, unknown>;
    a['extra'] = 1;
    expect(FixtureFileSchema.safeParse(a).success).toBe(false);
    const b = good();
    (b.meta as Record<string, unknown>)['token'] = 'x';
    expect(FixtureFileSchema.safeParse(b).success).toBe(false);
    const c = good();
    (c.response as Record<string, unknown>)['extra'] = 1;
    expect(FixtureFileSchema.safeParse(c).success).toBe(false);
    const d = { ...good(), response: { timeout: true, status: 200 } };
    expect(FixtureFileSchema.safeParse(d).success).toBe(false);
  });
  it('refuses a bad source, operation, step, or an unlabelled recording', () => {
    const bad = (m: Record<string, unknown>) => {
      const g = good();
      return FixtureFileSchema.safeParse({ ...g, meta: { ...g.meta, ...m } }).success;
    };
    expect(bad({ source: 'guess' })).toBe(false);
    expect(bad({ operation: 'payouts' })).toBe(false);
    expect(bad({ step: 0 })).toBe(false);
    expect(bad({ step: 1.5 })).toBe(false);
    expect(bad({ source: 'sandbox-recording', recorded_at: null })).toBe(false);
    expect(bad({ source: 'sandbox-recording', recorded_at: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(bad({ source: 'synthetic', recorded_at: '2026-01-01T00:00:00Z' })).toBe(false);
    expect(bad({ recorded_at: 'yesterday' })).toBe(false);
  });
  it('refuses a template or method that does not belong to the operation', () => {
    const g = good();
    expect(
      FixtureFileSchema.safeParse({ ...g, request: { ...g.request, method: 'POST' } }).success,
    ).toBe(false);
    expect(
      FixtureFileSchema.safeParse({ ...g, request: { ...g.request, path_template: '/v1/payouts' } })
        .success,
    ).toBe(false);
  });
});

describe('loadFixtures', () => {
  it('loads every json file under a directory tree in a stable order', async () => {
    const b = good();
    b.meta.scenario = 'b';
    const a = good();
    a.meta.scenario = 'a';
    const d = await dirWith({ 'z/b.json': b, 'a/a.json': a, 'a/readme.txt': 'ignored' });
    const out = await loadFixtures(d);
    expect(out.map((f) => f.meta.scenario)).toEqual(['a', 'b']);
  });
  it('refuses unknown fields and says which file', async () => {
    const x = { ...good(), surprise: true };
    const d = await dirWith({ 'bad.json': x });
    await expect(loadFixtures(d)).rejects.toThrow(/bad\.json/);
  });
  it('refuses invalid JSON and a duplicate scenario/operation/step', async () => {
    await expect(loadFixtures(await dirWith({ 'bad.json': '{' }))).rejects.toThrow(/bad\.json/);
    await expect(
      loadFixtures(await dirWith({ 'one.json': good(), 'two.json': good() })),
    ).rejects.toThrow(/duplicate/i);
  });
  it('skips index.json', async () => {
    const d = await dirWith({ 'index.json': [], 'one.json': good() });
    expect(await loadFixtures(d)).toHaveLength(1);
  });
});
