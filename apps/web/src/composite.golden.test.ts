// DP-5 (MVP-D) golden: every string a buyer is shown for a pack. The static lines come from the copy
// module; the order lines come from the real engine over the dry-run model (stored state in, text
// out). The reviewed file is golden/composite-copy.golden.txt. A change to it is a change to what
// people are told about money. D-051 pins the rule, not the literal: the verb follows the number of
// titles, and "not charged" is said only of a declined, failed or abandoned PayPal order.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import {
  BUY_SELECTED,
  CANCEL_BODY,
  CANCEL_HEADING,
  LINE_TEXT,
  MIXED_CURRENCY_TEXT,
  TOO_MANY_PUBLISHERS_TEXT,
  packNotice,
  stepButton,
  stepDeadline,
  stepHeading,
} from './lib/composite-copy';
import {
  HARBOUR_DOCK,
  HARBOUR_FERRY,
  HARBOUR_KNOTS,
  HARBOUR_TIDE,
  QUAY_MARKET,
  QUAY_WALK,
  bootPackApp,
  buyer,
  runPackByPublisher,
} from './composite-support';

vi.mock('server-only', () => ({}));

const HARBOUR = 'Harbour Ledger Review (fictional)';
const QUAYSIDE = 'Quayside Gazette (fictional)';
const golden = readFileSync(new URL('./golden/composite-copy.golden.txt', import.meta.url), 'utf8');

let app: App;
let A: Actor;
let B: Actor;
beforeAll(async () => {
  app = await bootPackApp();
  A = await buyer(app, 'a');
  B = await buyer(app, 'b');
});
afterAll(async () => {
  await app.close();
});

async function view(actor: Actor, order_ref: string, label: string): Promise<string[]> {
  const v = (await app.engine.orderView({ order_ref, actor }))!;
  const items = [...v.items].sort((x, y) => (x.publisher ?? '').localeCompare(y.publisher ?? ''));
  return [
    `${label}: ${v.buyer_message}`,
    ...items.map(
      (it, i) => `${label}, line ${String(i + 1)}: ${it.title}, ${it.publisher}: ${it.line}`,
    ),
  ];
}

describe('composite copy (golden)', () => {
  it('matches golden/composite-copy.golden.txt', async () => {
    const both = await runPackByPublisher(app, A, [HARBOUR_TIDE, QUAY_MARKET], {
      [HARBOUR]: 'happy',
      [QUAYSIDE]: 'happy',
    });
    const declined = await runPackByPublisher(app, A, [HARBOUR_FERRY, QUAY_WALK], {
      [HARBOUR]: 'happy',
      [QUAYSIDE]: 'declined',
    });
    const mismatch = await runPackByPublisher(app, B, [HARBOUR_KNOTS, QUAY_MARKET], {
      [HARBOUR]: 'happy',
      [QUAYSIDE]: 'mismatch_payee',
    });
    const frozen = await runPackByPublisher(app, B, [HARBOUR_DOCK, QUAY_WALK], {
      [HARBOUR]: 'happy',
      [QUAYSIDE]: 'happy',
    });
    await app.db.query(
      `UPDATE provider_orders SET state = 'frozen'
        WHERE order_id = $1 AND publisher_id = (SELECT id FROM publishers WHERE slug = 'quayside-gazette')`,
      [frozen.order_id],
    );
    const lines = [
      `approve, pack notice: ${packNotice(2)}`,
      `discover, select button: ${BUY_SELECTED}`,
      `discover, mixed currency: ${MIXED_CURRENCY_TEXT}`,
      `discover, too many publishers: ${TOO_MANY_PUBLISHERS_TEXT}`,
      `step page, heading: ${stepHeading(2, 2, QUAYSIDE)}`,
      `step page, button: ${stepButton(2, 2)}`,
      `step page, deadline (60 minute window): ${stepDeadline(60)}`,
      `step page, deadline (30 minute window): ${stepDeadline(30)}`,
      `cancel page, heading: ${CANCEL_HEADING}`,
      `cancel page, body: ${CANCEL_BODY}`,
      `item line, ready: ${LINE_TEXT.ready}`,
      `item line, paid but not unlocked: ${LINE_TEXT.paid_locked}`,
      `item line, refunded: ${LINE_TEXT.refunded}`,
      `item line, partly refunded: ${LINE_TEXT.partly_refunded}`,
      `item line, declined or failed: ${LINE_TEXT.declined}`,
      `item line, abandoned: ${LINE_TEXT.abandoned}`,
      `item line, on hold: ${LINE_TEXT.hold}`,
      `item line, waiting for approval: ${LINE_TEXT.awaiting}`,
      `item line, approved, other payment open: ${LINE_TEXT.approved}`,
      `item line, confirming: ${LINE_TEXT.confirming}`,
      `item line, pending: ${LINE_TEXT.pending}`,
      ...(await view(A, both.order_ref, 'pack, both ready')),
      ...(await view(A, declined.order_ref, 'pack, one ready, one declined')),
      ...(await view(B, mismatch.order_ref, 'pack, payee mismatch')),
      ...(await view(B, frozen.order_ref, 'pack, captured then frozen')),
    ];
    // The banner line has no "line N" suffix; the engine lines do. Same shape as the file.
    expect(lines.join('\n') + '\n').toBe(golden);
  });

  it('pins the D-051 rules, not only the literals', () => {
    const rows = golden.split('\n').filter((l) => l !== '');
    for (const row of rows) {
      // "not charged" appears only for declined, failed or abandoned payments, or the 60/30 minute notice.
      if (/not charged/i.test(row)) {
        expect(row, row).toMatch(
          /declined|was not completed|nothing is charged|was not charged|Nothing was charged/,
        );
      }
      if (/on hold/i.test(row)) expect(row, row).not.toMatch(/not charged/i);
    }
    // The verb follows the number of titles.
    expect(golden).toMatch(/ and .* are ready in your library\./);
    expect(golden).toMatch(/^pack, one ready, one declined: [^.]* is ready in your library\./m);
    expect(golden).toMatch(/ and .* are on hold while we check them\./);
    expect(golden).toMatch(/is on hold while we check it\./);
  });
});
