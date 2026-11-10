// WEB-IMPORT-SW (docs/specs/web-import-switch.md): the web import (domain proof, feed fetch, the queued run) is
// gated by its own switch, web_import_enabled, and by maintenance. It never reads paypal_outbound. A missing
// switch row is paused (fail closed). Real booted offline app, scripted web, no socket.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import {
  SHOP,
  SHOP_HOST,
  SOURCE_URL,
  bootImportWorld,
  fakeWeb,
  homeWithToken,
  shopPages,
  verifyShopOverHttp,
} from './web-import-support';
import type { ImportWebWorld } from './web-import-support';
import { switchLines } from './lib/switches-view';

vi.mock('server-only', () => ({}));

const worlds: ImportWebWorld[] = [];
const data = (name: string): string =>
  readFileSync(new URL(`../../../domain/catalogue/test-data/${name}`, import.meta.url), 'utf8');
const boot = async (): Promise<ImportWebWorld> => {
  const w = await bootImportWorld({ web: fakeWeb(shopPages(data)) });
  worlds.push(w);
  return w;
};
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.app.close();
});
const harbour = (w: ImportWebWorld) => w.pub['harbour-ledger'];
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T;
const setSw = (w: ImportWebWorld, name: string, on: boolean) =>
  w.app.db.query(`UPDATE safety_switches SET "on" = $2 WHERE name = $1`, [name, on]);
const OPERATOR: Actor = { kind: 'operator', operator_id: 'opr_import_sw', mfa: true };

describe('the switch row', () => {
  it('exists in the booted app, and a dry run boot turns the untouched seed row on (no socket is opened)', async () => {
    const w = await boot();
    const r = await w.app.db.query<{ on: boolean; changed_by: string }>(
      `SELECT "on", changed_by FROM safety_switches WHERE name = 'web_import_enabled'`,
    );
    expect(r.rows).toEqual([{ on: true, changed_by: 'seed:dryrun' }]);
  });
});

describe('the import follows web_import_enabled, not paypal_outbound', () => {
  it('web_import_enabled on and paypal_outbound off: "Check my site" and begin both go through', async () => {
    const w = await boot();
    await setSw(w, 'paypal_outbound', false);
    await setSw(w, 'web_import_enabled', true);
    const a = await w.post('domains', harbour(w), { host: SHOP_HOST });
    const { token } = await json<{ token: string }>(a);
    w.web.pages[`${SHOP}/`] = { body: homeWithToken(token) };
    const c = await w.post('check', harbour(w), { host: SHOP_HOST });
    expect(c.status).toBe(200);
    expect(await json(c)).toEqual({ host: SHOP_HOST, state: 'verified' });
    expect(w.web.calls.length).toBeGreaterThan(0);
    const b = await w.post('begin', harbour(w), { source_url: SOURCE_URL });
    expect(b.status).toBe(200);
    expect(await w.app.engine.webImport.runPending()).toEqual({ ran: 1 });
    const id = (await json<{ batch_id: string }>(b)).batch_id;
    const row = (
      await w.app.db.query<{ state: string }>('SELECT state FROM import_batches WHERE id = $1', [
        id,
      ])
    ).rows[0]!;
    expect(row.state).toBe('done');
  });

  it('web_import_enabled off and paypal_outbound on: begin answers 409 paused, "Check my site" answers 409 paused, nothing is fetched', async () => {
    const w = await boot();
    await verifyShopOverHttp(w);
    await setSw(w, 'paypal_outbound', true);
    await setSw(w, 'web_import_enabled', false);
    const r = await w.post('begin', harbour(w), { source_url: SOURCE_URL });
    expect(r.status).toBe(409);
    expect((await json<{ error: { code: string } }>(r)).error.code).toBe('paused');
    await w.post('domains', harbour(w), { host: 'other.pub-one.invalid' });
    const c = await w.post('check', harbour(w), { host: 'other.pub-one.invalid' });
    expect(c.status).toBe(409);
    expect((await json<{ error: { code: string } }>(c)).error.code).toBe('paused');
    expect(w.web.calls).toHaveLength(0);
  });

  it('a missing switch row is paused (fail closed)', async () => {
    const w = await boot();
    await verifyShopOverHttp(w);
    await w.app.db.query('ALTER TABLE safety_switches DISABLE TRIGGER safety_switches_no_delete');
    await w.app.db.query(`DELETE FROM safety_switches WHERE name = 'web_import_enabled'`);
    await setSw(w, 'paypal_outbound', true);
    const r = await w.post('begin', harbour(w), { source_url: SOURCE_URL });
    expect(r.status).toBe(409);
    expect((await json<{ error: { code: string } }>(r)).error.code).toBe('paused');
    expect(w.web.calls).toHaveLength(0);
  });

  it('a queued batch whose run starts with web_import_enabled off ends interrupted (paused), with nothing fetched', async () => {
    const w = await boot();
    await verifyShopOverHttp(w);
    const b = await w.post('begin', harbour(w), { source_url: SOURCE_URL });
    const id = (await json<{ batch_id: string }>(b)).batch_id;
    await setSw(w, 'web_import_enabled', false);
    await setSw(w, 'paypal_outbound', true);
    w.web.calls.length = 0;
    await w.app.engine.webImport.runPending();
    expect(w.web.calls).toHaveLength(0);
    const row = (
      await w.app.db.query<{ state: string; note: string }>(
        'SELECT state, note FROM import_batches WHERE id = $1',
        [id],
      )
    ).rows[0]!;
    expect(row).toEqual({ state: 'interrupted', note: 'paused' });
  });
});

describe('the operator toggle', () => {
  it('turning it off and on writes one audit row each, with the reason code', async () => {
    const w = await boot();
    const off = await w.app.engine.setFeatureSwitch({
      actor: { ...OPERATOR, mfa: false },
      name: 'web_import_enabled',
      on: false,
      reason_code: 'incident',
    });
    expect(off.ok).toBe(true);
    const on = await w.app.engine.setFeatureSwitch({
      actor: OPERATOR,
      name: 'web_import_enabled',
      on: true,
      reason_code: 'maintenance',
    });
    expect(on.ok).toBe(true);
    const rows = await w.app.db.query<{ action: string; reason: string }>(
      `SELECT action, reason FROM audit_log WHERE action LIKE 'switch.web_import_enabled.%' ORDER BY created_at, id`,
    );
    expect(rows.rows.map((x) => x.action).sort()).toEqual([
      'switch.web_import_enabled.off',
      'switch.web_import_enabled.on',
    ]);
    const state = await w.app.db.query<{ on: boolean; changed_by: string }>(
      `SELECT "on", changed_by FROM safety_switches WHERE name = 'web_import_enabled'`,
    );
    expect(state.rows).toEqual([{ on: true, changed_by: 'operator:opr_import_sw' }]);
  });

  it('turning it on needs the authenticator code, and it has no control of its own (not use_existing_control)', async () => {
    const w = await boot();
    await setSw(w, 'web_import_enabled', false);
    const r = await w.app.engine.setFeatureSwitch({
      actor: { ...OPERATOR, mfa: false },
      name: 'web_import_enabled',
      on: true,
      reason_code: 'maintenance',
    });
    expect(r).toEqual({ ok: false, error: 'mfa_required' });
    const ok = await w.app.engine.setFeatureSwitch({
      actor: OPERATOR,
      name: 'web_import_enabled',
      on: true,
      reason_code: 'maintenance',
    });
    expect(ok.ok).toBe(true);
  });

  it('the Controls snapshot lists it, with a label and an on or off toggle', async () => {
    const w = await boot();
    await setSw(w, 'web_import_enabled', false);
    const snap = await w.app.engine.opsSnapshot(OPERATOR);
    expect(snap).not.toBeNull();
    expect(snap!.switches.web_import_enabled).toBe(false);
    const line = switchLines(snap!.switches, false).find((l) => l.name === 'web_import_enabled')!;
    expect(line.label).toBe('Website import');
    expect(line.hint).not.toBe('');
    expect(line.toggle).toEqual({
      action: 'on',
      needs_mfa: true,
      path: '/api/ops/switches/web_import_enabled/on',
    });
    expect(line.note).toBeNull();
  });
});
