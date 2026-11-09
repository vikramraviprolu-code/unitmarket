// DP-5 (MVP-D) golden: every string a buyer is shown for a pack. The static lines come from the copy
// module; the order lines come from the real engine over the dry-run model (stored state in, text
// out). The reviewed file is golden/composite-copy.golden.txt. A change to it is a change to what
// people are told about money. D-051 pins the rule, not the literal: the verb follows the number of
// titles, and "not charged" is said only of a declined, failed or abandoned PayPal order.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import type { LineKind } from './lib/composite-copy';
import {
  BUY_SELECTED,
  CANCEL_BODY,
  CANCEL_BACK_LINK,
  CANCEL_BODY_NO_REF,
  CANCEL_HEADING,
  CANCEL_WINDOW_LINE,
  LINE_TEXT,
  CORRIDOR_UNSUPPORTED_TEXT,
  MIXED_CURRENCY_TEXT,
  PUBLISHER_UNVERIFIED_TEXT,
  TOO_MANY_PUBLISHERS_TEXT,
  packNotice,
  stepButton,
  stepDeadline,
  stepHeading,
} from './lib/composite-copy';
import {
  CAPTURED_THEN_HELD,
  HARBOUR_FEES,
  HARBOUR_FERRY,
  HARBOUR_KNOTS,
  HARBOUR_TIDE,
  QUAY_MARKET,
  QUAY_WALK,
  bootPackApp,
  buyer,
  runPackByPublisher,
} from './composite-support';
import { orderTone } from './lib/order-status';

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

async function view(a: App, actor: Actor, order_ref: string, label: string): Promise<string[]> {
  const v = (await a.engine.orderView({ order_ref, actor }))!;
  const items = [...v.items].sort((x, y) => (x.publisher ?? '').localeCompare(y.publisher ?? ''));
  return [
    `${label}: ${v.buyer_message}`,
    `${label}, tone: ${orderTone(v)}`,
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
    // A real pack: one PayPal order captured and read back, the other held after its capture. Reached
    // through the engine on the dry-run model (DP-5b), not by writing a state into the table.
    const frozen = await runPackByPublisher(app, B, [HARBOUR_FEES, QUAY_WALK], {
      [HARBOUR]: 'happy',
      [QUAYSIDE]: CAPTURED_THEN_HELD,
    });
    // The stored-state shape kept from DP-5: the order is `paid` and one PayPal order is then set to
    // frozen by hand. A second app so that no article is bought twice. Not reachable by the engine;
    // it pins the words and the tone for that stored shape too.
    const stored = await bootPackApp();
    let storedRows: string[] = [];
    try {
      const SB = await buyer(stored, 'b');
      const run = await runPackByPublisher(stored, SB, [HARBOUR_FEES, QUAY_WALK], {
        [HARBOUR]: 'happy',
        [QUAYSIDE]: 'happy',
      });
      await stored.db.query(
        `UPDATE provider_orders SET state = 'frozen'
          WHERE order_id = $1 AND publisher_id = (SELECT id FROM publishers WHERE slug = 'quayside-gazette')`,
        [run.order_id],
      );
      storedRows = await view(stored, SB, run.order_ref, 'pack, paid then frozen by update');
    } finally {
      await stored.close();
    }
    const lines = [
      `approve, pack notice: ${packNotice(2)}`,
      `discover, select button: ${BUY_SELECTED}`,
      `discover, mixed currency: ${MIXED_CURRENCY_TEXT}`,
      `discover, too many publishers: ${TOO_MANY_PUBLISHERS_TEXT}`,
      `approve, corridor unsupported: ${CORRIDOR_UNSUPPORTED_TEXT}`,
      `approve, publisher unverified: ${PUBLISHER_UNVERIFIED_TEXT}`,
      `step page, heading: ${stepHeading(2, 2, QUAYSIDE)}`,
      `step page, button: ${stepButton(2, 2)}`,
      `step page, deadline (60 minute window): ${stepDeadline(60)}`,
      `step page, deadline (30 minute window): ${stepDeadline(30)}`,
      `cancel page, heading: ${CANCEL_HEADING}`,
      `cancel page, body (valid ref): ${CANCEL_BODY}`,
      `cancel page, body (no valid ref): ${CANCEL_BODY_NO_REF}`,
      `cancel page, back sentence (valid ref): ${CANCEL_WINDOW_LINE}`,
      `cancel page, back link (valid ref): ${CANCEL_BACK_LINK}`,
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
      ...(await view(app, A, both.order_ref, 'pack, both ready')),
      ...(await view(app, A, declined.order_ref, 'pack, one ready, one declined')),
      ...(await view(app, B, mismatch.order_ref, 'pack, payee mismatch')),
      ...(await view(app, B, frozen.order_ref, 'pack, captured then frozen')),
      ...storedRows,
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

  // L4 (DP-5b): "was not charged" is tied to the KIND of the item line, not only to the sentence.
  it('"was not charged" appears only on rows whose item kind is not_charged, never on a hold or ready row', () => {
    const KIND_OF_TEXT = new Map(
      (Object.entries(LINE_TEXT) as [LineKind, string][]).map(([k, t]) => [t, k]),
    );
    const NOT_CHARGED_KINDS = new Set<LineKind>(['declined', 'abandoned']);
    const verdict = checkNotChargedRows(
      golden.split('\n').filter((l) => l !== ''),
      KIND_OF_TEXT,
      NOT_CHARGED_KINDS,
    );
    expect(verdict.problems).toEqual([]);
    // The check has teeth: the kinds ready, declined and hold are all present, and it catches a hold said to be not charged.
    expect(verdict.kinds.sort()).toEqual(['declined', 'hold', 'ready']);
    const bad = golden.replace(
      'A morning walk along the old quay is on hold while we check it.',
      'A morning walk along the old quay was not charged.',
    );
    expect(
      checkNotChargedRows(
        bad.split('\n').filter((l) => l !== ''),
        KIND_OF_TEXT,
        NOT_CHARGED_KINDS,
      ).problems.length,
    ).toBeGreaterThan(0);
    const badLine = golden.replace(
      'Why ferry timetables slip in winter, Harbour Ledger Review (fictional): Ready in your library',
      'Why ferry timetables slip in winter, Harbour Ledger Review (fictional): Not charged: PayPal declined this payment',
    );
    expect(
      checkNotChargedRows(
        badLine.split('\n').filter((l) => l !== ''),
        KIND_OF_TEXT,
        NOT_CHARGED_KINDS,
      ).problems.length,
    ).toBeGreaterThan(0);
  });
});

/**
 * For each pack in the golden rows: the item lines give each title its kind (the text after the last
 * colon is one of LINE_TEXT); the banner's "was/were not charged" sentence may name a title only if
 * its kind is declined or abandoned, and must name every title of those kinds. A line row that says
 * "Not charged" must be a declined or abandoned kind.
 */
function checkNotChargedRows(
  rows: string[],
  kindOfText: Map<string, LineKind>,
  notCharged: Set<LineKind>,
): { problems: string[]; kinds: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();
  const packs = rows.filter((r) => r.startsWith('pack, ') && !/, (line \d+|tone):/.test(r));
  for (const banner of packs) {
    const label = banner.slice(0, banner.indexOf(': '));
    const text = banner.slice(label.length + 2);
    const lines = rows
      .filter((r) => r.startsWith(`${label}, line `))
      .map((r) => {
        const body = r.slice(r.indexOf(': ') + 2);
        // the line text may itself hold a colon ("Not charged: ..."): find the known text at the end
        const hit = [...kindOfText.keys()].find((t) => body.endsWith(`: ${t}`));
        return {
          title: body.slice(0, body.indexOf(', ')),
          kind: hit === undefined ? null : kindOfText.get(hit)!,
        };
      });
    const sentence = text.split('. ').find((x) => /not charged\.?$/.test(x)) ?? '';
    for (const l of lines) {
      if (l.kind === null) {
        problems.push(`${label}: unknown line text for ${l.title}`);
        continue;
      }
      seen.add(l.kind);
      const named = sentence.includes(l.title);
      if (named !== notCharged.has(l.kind)) {
        problems.push(
          `${label}: "${l.title}" is ${l.kind} but ${named ? 'is' : 'is not'} said to be not charged`,
        );
      }
    }
  }
  for (const r of rows.filter((x) => /, line \d+: /.test(x))) {
    if (/: Not charged/.test(r)) {
      const hit = [...kindOfText.keys()].find((t) => r.endsWith(`: ${t}`));
      const kind = hit === undefined ? null : kindOfText.get(hit)!;
      if (kind === null || !notCharged.has(kind)) problems.push(`line says Not charged: ${r}`);
    }
  }
  return { problems, kinds: [...seen] };
}
