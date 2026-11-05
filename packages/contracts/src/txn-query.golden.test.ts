// INT-SR0 (SR0.1): the TxnQuery contract. 40 URL cases (an invalid value is dropped, never an error, so a
// stale link still opens), the status groups table, statusGroupOf precedence with an injected clock, and the
// refused-field table by role. Golden: the expected values are written out here, not computed from the code.
import { describe, expect, it } from 'vitest';
import {
  PENDING_ATTENTION_MS,
  REFUSED_FIELDS,
  STATUS_GROUPS,
  StatusGroupSchema,
  TXN_QUERY_KEYS,
  TxnQuerySchema,
  parseTxnQuery,
  statusGroupOf,
} from './txn-query';

type Case = readonly [name: string, raw: Record<string, string>, expected: Record<string, unknown>];

const q100 = 'q'.repeat(100);
const q101 = 'q'.repeat(101);

const CASES: readonly Case[] = [
  ['01 empty map', {}, {}],
  ['02 from kept', { from: '2026-11-01' }, { from: '2026-11-01' }],
  ['03 from with month 13 dropped', { from: '2026-13-01' }, {}],
  ['04 from 30 February dropped', { from: '2026-02-30' }, {}],
  ['05 from without zero padding dropped', { from: '2026-1-1' }, {}],
  ['06 to kept', { to: '2026-11-30' }, { to: '2026-11-30' }],
  ['07 from after to: both dropped', { from: '2026-11-30', to: '2026-11-01' }, {}],
  [
    '08 from equal to kept',
    { from: '2026-11-05', to: '2026-11-05' },
    { from: '2026-11-05', to: '2026-11-05' },
  ],
  ['09 min_minor kept', { min_minor: '500' }, { min_minor: 500 }],
  ['10 min_minor negative dropped', { min_minor: '-5' }, {}],
  ['11 min_minor decimal dropped', { min_minor: '1.5' }, {}],
  ['12 min_minor words dropped', { min_minor: 'five' }, {}],
  ['13 min_minor above 2^31-1 dropped', { min_minor: '2147483648' }, {}],
  ['14 max_minor zero kept', { max_minor: '0' }, { max_minor: 0 }],
  ['15 min above max: both dropped', { min_minor: '900', max_minor: '100' }, {}],
  ['16 currency upper-cased', { currency: 'usd,EUR' }, { currency: ['USD', 'EUR'] }],
  ['17 currency invalid items dropped', { currency: 'usd,xx,EUROS' }, { currency: ['USD'] }],
  ['18 currency all invalid dropped', { currency: '12,x' }, {}],
  ['19 currency duplicates removed', { currency: 'USD,usd' }, { currency: ['USD'] }],
  ['20 status list', { status: 'paid,refunded' }, { status: ['paid', 'refunded'] }],
  ['21 status unknown word dropped', { status: 'paid,bogus' }, { status: ['paid'] }],
  ['22 status all unknown dropped', { status: 'bogus' }, {}],
  [
    '23 status all six words, in order given',
    { status: 'attention,failed,paid,part_refunded,refunded,in_progress' },
    { status: ['attention', 'failed', 'paid', 'part_refunded', 'refunded', 'in_progress'] },
  ],
  [
    '24 status spaces and repeats',
    { status: 'paid, refunded,paid' },
    { status: ['paid', 'refunded'] },
  ],
  ['25 refund list', { refund: 'none,partial' }, { refund: ['none', 'partial'] }],
  ['26 refund unknown dropped', { refund: 'half' }, {}],
  ['27 case list', { case: 'open,resolved' }, { case: ['open', 'resolved'] }],
  ['28 flags list', { flags: 'alert,unknown_op' }, { flags: ['alert', 'unknown_op'] }],
  ['29 flags unknown dropped', { flags: 'fire' }, {}],
  ['30 buyer id kept', { buyer: 'buy_1' }, { buyer: 'buy_1' }],
  ['31 buyer empty dropped', { buyer: '' }, {}],
  ['32 seller trimmed', { seller: '  harbour ' }, { seller: 'harbour' }],
  ['33 q of 100 characters kept', { q: q100 }, { q: q100 }],
  ['34 q of 101 characters dropped', { q: q101 }, {}],
  ['35 q with a control character dropped', { q: 'pine\u0000' }, {}],
  ['36 ref kept', { ref: 'PAYPAL000123' }, { ref: 'PAYPAL000123' }],
  [
    '37 channel and agent key kept',
    { channel: 'agent', agent_key: 'key_b2' },
    { channel: 'agent', agent_key: 'key_b2' },
  ],
  ['38 channel unknown dropped', { channel: 'robot' }, {}],
  [
    '39 environment, sort and dir kept; bad sort dropped',
    { environment: 'sandbox', sort: 'amount', dir: 'asc' },
    { environment: 'sandbox', sort: 'amount', dir: 'asc' },
  ],
  [
    '40 limit bounds and unknown keys',
    { limit: '101', sort: 'bogus', dir: 'up', environment: 'live', unknown: 'x' },
    {},
  ],
];

describe('TxnQuery URL parse (SR0.1)', () => {
  it('has exactly 40 cases', () => {
    expect(CASES).toHaveLength(40);
  });

  it.each(CASES)('%s', (_name, raw, expected) => {
    expect(parseTxnQuery(raw)).toEqual(expected);
  });

  it('keeps limit 1 to 100 and drops 0, 101, decimals and words', () => {
    expect(parseTxnQuery({ limit: '1' })).toEqual({ limit: 1 });
    expect(parseTxnQuery({ limit: '100' })).toEqual({ limit: 100 });
    for (const bad of ['0', '101', '25.5', 'many', '-1', '']) {
      expect(parseTxnQuery({ limit: bad }), bad).toEqual({});
    }
  });

  it('passes a cursor on untouched (a bad one is refused later, never turned into page 1)', () => {
    expect(parseTxnQuery({ cursor: 'abc_DEF-123' })).toEqual({ cursor: 'abc_DEF-123' });
    // A cursor that is too long to store still reaches the decoder, which refuses it.
    const long = 'x'.repeat(5000);
    const out = parseTxnQuery({ cursor: long });
    expect(out.cursor).toBeDefined();
    expect(out.cursor).not.toBe(long);
    expect(parseTxnQuery({ cursor: '' })).toEqual({});
  });

  it('every parsed value passes the strict schema, and the schema refuses an unknown key', () => {
    for (const [, raw] of CASES) {
      const parsed = parseTxnQuery(raw);
      expect(TxnQuerySchema.parse(parsed)).toEqual(parsed);
    }
    expect(() => TxnQuerySchema.parse({ surprise: 1 })).toThrow();
  });

  it('TXN_QUERY_KEYS names every filter, the sort, the direction, the limit and the cursor', () => {
    expect([...TXN_QUERY_KEYS].sort()).toEqual(
      [
        'agent_key',
        'buyer',
        'case',
        'channel',
        'currency',
        'cursor',
        'dir',
        'environment',
        'flags',
        'from',
        'limit',
        'max_minor',
        'min_minor',
        'q',
        'ref',
        'refund',
        'seller',
        'sort',
        'status',
        'to',
      ].sort(),
    );
  });
});

describe('status groups (SR0.1)', () => {
  it('lists the six words in precedence order', () => {
    expect(StatusGroupSchema.options).toEqual([
      'attention',
      'refunded',
      'part_refunded',
      'paid',
      'failed',
      'in_progress',
    ]);
  });

  it('STATUS_GROUPS maps each word to order and unit statuses, as the spec table says', () => {
    expect(STATUS_GROUPS).toEqual({
      attention: { order: ['unresolved', 'frozen'], unit: ['mismatch', 'reversal_suspected'] },
      refunded: { order: [], unit: ['refunded', 'reversed'] },
      part_refunded: { order: [], unit: ['partially_refunded'] },
      paid: { order: [], unit: ['captured_verified'] },
      failed: { order: ['failed', 'abandoned'], unit: ['declined'] },
      in_progress: {
        order: [
          'created',
          'awaiting_buyer',
          'capture_requested',
          'capture_claimed',
          'paid_partial',
        ],
        unit: ['expected', 'pending'],
      },
    });
    expect(PENDING_ATTENTION_MS).toBe(3_600_000);
  });

  const NOW = new Date('2026-11-05T12:00:00.000Z');
  const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

  // [order status, unit status, minutes since the unit changed, expected word]
  const TABLE: ReadonlyArray<readonly [string, string, number, string]> = [
    // attention wins over everything else
    ['unresolved', 'captured_verified', 5, 'attention'],
    ['frozen', 'refunded', 5, 'attention'],
    ['paid', 'mismatch', 5, 'attention'],
    ['paid', 'reversal_suspected', 5, 'attention'],
    ['failed', 'mismatch', 5, 'attention'],
    // a pending unit is attention only when it is OLDER than one hour
    ['capture_claimed', 'pending', 59, 'in_progress'],
    ['capture_claimed', 'pending', 60, 'in_progress'],
    ['capture_claimed', 'pending', 61, 'attention'],
    ['paid_partial', 'pending', 600, 'attention'],
    // refunded, then part_refunded, then paid
    ['paid', 'refunded', 5, 'refunded'],
    ['paid', 'reversed', 5, 'refunded'],
    ['paid', 'partially_refunded', 5, 'part_refunded'],
    ['paid', 'captured_verified', 5, 'paid'],
    ['paid_partial', 'captured_verified', 5, 'paid'],
    // failed: an order that failed or was abandoned, or a declined unit
    ['failed', 'expected', 5, 'failed'],
    ['abandoned', 'expected', 5, 'failed'],
    ['paid_partial', 'declined', 5, 'failed'],
    ['awaiting_buyer', 'declined', 5, 'failed'],
    // everything else is in progress
    ['created', 'expected', 5, 'in_progress'],
    ['awaiting_buyer', 'expected', 5, 'in_progress'],
    ['capture_requested', 'expected', 5, 'in_progress'],
    ['capture_claimed', 'expected', 5, 'in_progress'],
    ['paid_partial', 'expected', 5, 'in_progress'],
    ['capture_claimed', 'pending', 5, 'in_progress'],
  ];

  it.each(TABLE)(
    'order %s, unit %s, %i min old: %s',
    (order_status, unit_status, minutes, word) => {
      const row = { order_status, unit_status, unit_updated_at: ago(minutes) };
      expect(statusGroupOf(row, NOW)).toBe(word);
    },
  );

  it('reads the age from the injected time, not from the machine clock', () => {
    const row = {
      order_status: 'capture_claimed',
      unit_status: 'pending',
      unit_updated_at: ago(30),
    };
    expect(statusGroupOf(row, NOW)).toBe('in_progress');
    expect(statusGroupOf(row, new Date(NOW.getTime() + 2 * 3_600_000))).toBe('attention');
    // A Date works as well as an ISO string.
    expect(statusGroupOf({ ...row, unit_updated_at: new Date(ago(90)) }, NOW)).toBe('attention');
  });

  it('gives one of the six words for every status pair', () => {
    const orders = [
      'created',
      'awaiting_buyer',
      'capture_requested',
      'capture_claimed',
      'unresolved',
      'paid',
      'paid_partial',
      'failed',
      'abandoned',
      'frozen',
    ];
    const units = [
      'expected',
      'captured_verified',
      'pending',
      'declined',
      'mismatch',
      'partially_refunded',
      'refunded',
      'reversal_suspected',
      'reversed',
    ];
    for (const o of orders)
      for (const u of units)
        for (const m of [5, 90]) {
          const word = statusGroupOf(
            { order_status: o, unit_status: u, unit_updated_at: ago(m) },
            NOW,
          );
          expect(StatusGroupSchema.options, `${o}/${u}`).toContain(word);
        }
  });
});

describe('refused fields by role (SR0.2 data)', () => {
  it('REFUSED_FIELDS equals the role table of the spec', () => {
    expect(REFUSED_FIELDS).toEqual({
      buyer: ['buyer', 'environment', 'flags'],
      agent: ['buyer', 'environment', 'flags'],
      publisher: ['buyer', 'seller', 'agent_key', 'environment', 'flags'],
      operator_key: [],
      operator: [],
    });
  });

  it('every refused field is a query key', () => {
    for (const fields of Object.values(REFUSED_FIELDS))
      for (const f of fields) expect(TXN_QUERY_KEYS).toContain(f);
  });
});
