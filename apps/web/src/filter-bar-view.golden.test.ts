// INT-OPS-B / OPS-B.1: the shared filter bar. lib/filter-bar-view.ts turns a URL into chips and the chips back
// into the same URL, with comma lists as in SR0. Twenty canonical URLs for the Transactions bar and a few for
// the Activity bar must come back unchanged; the status words are SR0's STATUS_GROUPS words.
import { describe, expect, it } from 'vitest';
import { STATUS_GROUPS } from '@umsbx/contracts';
import {
  ACTIVITY_FIELDS,
  ACTIVITY_PRESETS,
  SAVED_VIEWS,
  STATUS_LABEL,
  STATUS_WORDS,
  TXN_FIELDS,
  barState,
  mapFromChips,
  parseQueryString,
  queryString,
  withField,
  withoutChip,
} from './lib/filter-bar-view';
import type { BarContext } from './lib/filter-bar-view';

const OPERATOR: BarContext = { kind: 'txn', persona: 'operator' };
const ACTIVITY_MFA: BarContext = { kind: 'activity', mfa: true };

// Canonical form: fields in the bar's fixed order, then view, sort and dir. Commas stay commas.
const TXN_URLS = [
  '',
  'status=attention',
  'status=attention,paid',
  'currency=USD&status=paid,failed',
  'from=2026-11-01&to=2026-11-04',
  'min_minor=500&max_minor=2500',
  'currency=EUR,USD',
  'refund=partial,full&case=open',
  'buyer=Wes%20Watcher',
  'seller=Quay%20Views&q=tide',
  'ref=ref_vs_o1',
  'channel=agent',
  'agent_key=key_abc',
  'environment=sandbox',
  'flags=alert,mismatch',
  'view=needs_attention',
  'view=refunds_today&sort=amount&dir=asc',
  'sort=newest&dir=desc',
  'status=attention&refund=none&case=none&channel=human&environment=dryrun&flags=unknown_op',
  'from=2026-11-01&q=a%26b',
];

describe('OPS-B.1 URL to chips and back', () => {
  it('has twenty cases', () => {
    expect(TXN_URLS).toHaveLength(20);
  });

  it.each(TXN_URLS)('round-trips %j through the chips unchanged', (url) => {
    const state = barState(OPERATOR, parseQueryString(url));
    expect(queryString(state.map)).toBe(url);
    expect(queryString(mapFromChips(OPERATOR, state.chips, state.extras))).toBe(url);
  });

  it('gives one chip for each value of a list, so one value can be removed', () => {
    const state = barState(OPERATOR, parseQueryString('status=attention,paid&currency=USD'));
    expect(state.chips.map((c) => `${c.field}:${c.value}`)).toEqual([
      'currency:USD',
      'status:attention',
      'status:paid',
    ]);
    const without = withoutChip(
      OPERATOR,
      parseQueryString('status=attention,paid'),
      'status',
      'paid',
    );
    expect(queryString(without)).toBe('status=attention');
    const none = withoutChip(OPERATOR, parseQueryString('status=attention'), 'status', 'attention');
    expect(queryString(none)).toBe('');
  });

  it('adds a value to a list and replaces a single value', () => {
    const raw = parseQueryString('status=attention&channel=agent');
    expect(queryString(withField(OPERATOR, raw, 'status', 'paid'))).toBe(
      'status=attention,paid&channel=agent',
    );
    expect(queryString(withField(OPERATOR, raw, 'channel', 'human'))).toBe(
      'status=attention&channel=human',
    );
    // A value that is already there is not added twice; a value the field does not take changes nothing.
    expect(queryString(withField(OPERATOR, raw, 'status', 'attention'))).toBe(
      'status=attention&channel=agent',
    );
    expect(queryString(withField(OPERATOR, raw, 'status', 'bogus'))).toBe(
      'status=attention&channel=agent',
    );
  });

  it('turns an amount typed in money into minor units', () => {
    expect(queryString(withField(OPERATOR, {}, 'min_minor', '5.00'))).toBe('min_minor=500');
    expect(queryString(withField(OPERATOR, {}, 'max_minor', '12.5'))).toBe('max_minor=1250');
    expect(queryString(withField(OPERATOR, {}, 'max_minor', 'lots'))).toBe('');
  });

  it('drops the page cursor: a new filter always starts at page one', () => {
    const state = barState(OPERATOR, parseQueryString('status=paid&cursor=abc123'));
    expect(queryString(state.map)).toBe('status=paid');
  });

  it('gives each chip words a person can read, with no raw key as the only text', () => {
    const state = barState(
      OPERATOR,
      parseQueryString('status=part_refunded&from=2026-11-01&min_minor=500'),
    );
    expect(state.chips.map((c) => c.text)).toEqual([
      'From 2026-11-01',
      'Amount at least 5.00',
      `Status: ${STATUS_LABEL.part_refunded}`,
    ]);
  });
});

describe('OPS-B.1 the Activity bar', () => {
  const ACTIVITY_URLS = [
    '',
    'actor_kind=operator',
    'actor_kind=operator&channel=web&event_type=safety_switches.',
    'actor_id=opr_vikram&chain_key=plat',
    'from=2026-11-04T12%3A00%3A00.000Z&to=2026-11-05T12%3A00%3A00.000Z',
  ];
  it.each(ACTIVITY_URLS)('round-trips %j through the chips unchanged', (url) => {
    const state = barState(ACTIVITY_MFA, parseQueryString(url));
    expect(queryString(state.map)).toBe(url);
    expect(queryString(mapFromChips(ACTIVITY_MFA, state.chips, state.extras))).toBe(url);
  });

  it('has a switch history preset that filters the event type by the prefix safety_switches.', () => {
    const preset = ACTIVITY_PRESETS.find((p) => p.id === 'switch_history');
    expect(preset).toBeDefined();
    expect(preset!.label).toBe('Switch history');
    expect(preset!.map).toEqual({ event_type: 'safety_switches.' });
    expect(queryString(barState(ACTIVITY_MFA, preset!.map).map)).toBe(
      'event_type=safety_switches.',
    );
  });
});

describe('OPS-B.1 the words and presets come from the contract', () => {
  it('the status chip words are the keys of STATUS_GROUPS, in its order', () => {
    expect([...STATUS_WORDS]).toEqual(Object.keys(STATUS_GROUPS));
    expect(Object.keys(STATUS_LABEL)).toEqual(Object.keys(STATUS_GROUPS));
  });

  it('the bar has one field list for Transactions and one for Activity', () => {
    expect([...TXN_FIELDS]).toEqual([
      'from',
      'to',
      'min_minor',
      'max_minor',
      'currency',
      'status',
      'refund',
      'case',
      'buyer',
      'seller',
      'q',
      'ref',
      'channel',
      'agent_key',
      'environment',
      'flags',
    ]);
    expect([...ACTIVITY_FIELDS]).toEqual([
      'actor_kind',
      'actor_id',
      'channel',
      'event_type',
      'chain_key',
      'from',
      'to',
    ]);
  });

  it('offers SR1 saved views as presets, by id', () => {
    expect(SAVED_VIEWS.map((v) => v.id)).toEqual([
      'needs_attention',
      'refunds_today',
      'agent_purchases',
      'sandbox_only',
    ]);
    for (const v of SAVED_VIEWS) expect(v.label.length).toBeGreaterThan(3);
  });
});
