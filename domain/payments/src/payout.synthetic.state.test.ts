// POB-DEMOLINK: a synthetic payee (the dry run demo link: an address on the reserved .invalid domain, or the marker
// `seed:synthetic` in verified_by) is never a destination in the sandbox environment. Refused at creation (the unit is
// skipped and an operator is told once) and again at send (the port is not called). In dry run it is paid like any other.
// Real PGlite, a scripted payout port. Addresses are fictional.
import { afterEach, describe, expect, it } from 'vitest';
import { runPayoutPass } from './index';
import { paid } from './ops/support';
import type { OpsWorld } from './ops/support';
import {
  PAYEE_EMAIL,
  linkPayee,
  makePayoutWorld,
  pastWindow,
  payoutRows,
  spyPort,
  unitIdOf,
} from './payout-support';

const SYNTHETIC = 'demo-harbour-ledger@payee.invalid';
let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const sandbox = () => ({ ...w.deps, environment: 'sandbox' as const });
const pass = (port: ReturnType<typeof spyPort> | null, deps = w.deps) =>
  runPayoutPass(deps, port, { max_items: 100 });
/** A verified link as the dry run seed leaves it, or any variation of it. */
async function setLink(email: string, verified_by: string): Promise<void> {
  const at = w.clock.now().toISOString();
  await w.rows(
    `INSERT INTO publisher_paypal_links (publisher_id, paypal_email, state, verified_by, verified_at, created_at, updated_at)
     VALUES ('pub_1', $1, 'verified', $2, $3, $3, $3)
     ON CONFLICT (publisher_id) DO UPDATE
       SET paypal_email = EXCLUDED.paypal_email, state = 'verified', verified_by = EXCLUDED.verified_by,
           verified_at = $3, updated_at = $3`,
    [email, verified_by, at],
  );
}
const refusalReasons = async (): Promise<string[]> =>
  (
    await w.rows<{ detail: { reason: string } }>(
      "SELECT detail FROM alerts WHERE kind = 'payout_failed' ORDER BY detail ->> 'reason'",
    )
  ).map((x) => x.detail.reason);
/** One paid sale of pub_1 whose window has ended, in the given environment label. */
async function sale(environment: 'dryrun' | 'sandbox'): Promise<string> {
  w = await makePayoutWorld();
  const a = await paid(w);
  await pastWindow(w);
  if (environment === 'sandbox') {
    // The approval and order guards pin the environment, so a test row is moved with the guards off for the update only.
    for (const t of ['approvals', 'orders']) await w.rows(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    await w.rows("UPDATE approvals SET environment = 'sandbox'");
    await w.rows("UPDATE orders SET environment = 'sandbox'");
    for (const t of ['approvals', 'orders']) await w.rows(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  }
  return unitIdOf(w, a.order_id);
}

describe('creation in the sandbox environment', () => {
  it('a synthetic link creates no payout, tells an operator once, and a real verified address is paid after', async () => {
    const unit = await sale('sandbox');
    await setLink(SYNTHETIC, 'seed:synthetic');
    const port = spyPort(w);
    expect(await pass(port, sandbox())).toMatchObject({ created: 0, sent: 0 });
    expect(await pass(port, sandbox())).toMatchObject({ created: 0, sent: 0 });
    expect(await payoutRows(w)).toEqual([]);
    expect(port.calls).toHaveLength(0);
    expect(await refusalReasons()).toEqual([`payout_refused_${unit}_synthetic_payee`]);
    expect(JSON.stringify(await w.rows('SELECT * FROM alerts'))).not.toContain('payee.invalid');
    await linkPayee(w, 'pub_1', PAYEE_EMAIL.pub_1!);
    expect(await pass(port, sandbox())).toMatchObject({ created: 1, sent: 1 });
    expect(port.calls[0]!.payee_merchant_id).toBe(PAYEE_EMAIL.pub_1);
    expect(port.calls[0]!.environment).toBe('sandbox');
  });

  it('either sign is enough: the .invalid address under an operator id, or the marker on an ordinary address', async () => {
    await sale('sandbox');
    const port = spyPort(w);
    for (const [email, by] of [
      [SYNTHETIC, 'opr_test'],
      ['someone@example.test', 'seed:synthetic'],
      ['UPPER@PAYEE.INVALID', 'opr_test'],
    ] as const) {
      await setLink(email, by);
      expect(await pass(port, sandbox())).toMatchObject({ created: 0, sent: 0 });
    }
    expect(await payoutRows(w)).toEqual([]);
    expect(port.calls).toHaveLength(0);
  });
});

describe('send in the sandbox environment', () => {
  it('a due payout whose link became synthetic is not sent, is cancelled, tells an operator once; units are not paid to it again', async () => {
    const unit = await sale('sandbox');
    await pass(null, sandbox());
    const p = (await payoutRows(w))[0]!;
    expect(p).toMatchObject({ state: 'due', environment: 'sandbox' });
    await setLink(SYNTHETIC, 'seed:synthetic');
    const port = spyPort(w);
    expect(await pass(port, sandbox())).toMatchObject({ sent: 0, refused: 1 });
    expect(port.calls).toHaveLength(0);
    expect((await payoutRows(w)).map((x) => [x.id, x.state])).toEqual([[p.id, 'cancelled']]);
    expect(await refusalReasons()).toEqual([`payout_refused_${p.id}_synthetic_payee`]);
    // the next pass finds the freed unit and creation refuses it too (its own alert), once
    for (let i = 0; i < 2; i++)
      expect(await pass(port, sandbox())).toMatchObject({ created: 0, sent: 0, refused: 0 });
    expect(port.calls).toHaveLength(0);
    expect((await payoutRows(w)).map((x) => x.state)).toEqual(['cancelled']);
    expect(await refusalReasons()).toEqual([
      `payout_refused_${p.id}_synthetic_payee`,
      `payout_refused_${unit}_synthetic_payee`,
    ]);
  });

  it('a payout already in sending is refused and is not cancelled (the provider may hold it)', async () => {
    await sale('sandbox');
    const port = spyPort(w, 'throw_before_execute');
    expect(await pass(port, sandbox())).toMatchObject({ created: 1, errored: 1 });
    expect((await payoutRows(w))[0]!.state).toBe('sending');
    const p = (await payoutRows(w))[0]!;
    // the address is now synthetic: that is the reason given, ahead of payee_changed
    await setLink(SYNTHETIC, 'seed:synthetic');
    expect(await pass(port, sandbox())).toMatchObject({ sent: 0, refused: 1 });
    expect(port.calls).toHaveLength(1); // only the first, throwing, attempt
    expect((await payoutRows(w))[0]!.state).toBe('sending');
    expect(await refusalReasons()).toEqual([`payout_refused_${p.id}_synthetic_payee`]);
  });
});

describe('dry run', () => {
  it('pays a synthetic link like any other, to that address', async () => {
    await sale('dryrun');
    await setLink(SYNTHETIC, 'seed:synthetic');
    const port = spyPort(w);
    expect(await pass(port)).toMatchObject({ created: 1, sent: 1, refused: 0 });
    expect(port.calls[0]).toMatchObject({ payee_merchant_id: SYNTHETIC, environment: 'dryrun' });
    expect(await refusalReasons()).toEqual([]);
  });
});
