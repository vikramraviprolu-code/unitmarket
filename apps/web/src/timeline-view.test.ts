// INT-UI0 / UI0.6: the timeline component renders entries of TR1's shape, from fixtures until TR1 lands. The
// logic is in lib/timeline-view.ts (order, actor and channel words, empty and error states); ui/Timeline.tsx
// only paints what it returns. TR1 owns the contract type: its spec adds a type-level test that the contract
// entry can be given to TimelineEntryView.
import { describe, expect, it } from 'vitest';
import {
  ACTOR_WORDS,
  CHANNEL_WORDS,
  TIMELINE_ENTRY_FIELDS,
  TIMELINE_FIXTURES,
  timelineView,
  type TimelineEntryView,
} from './lib/timeline-view';

describe('TimelineEntryView is exactly the TR1 entry', () => {
  it('has these fields and no other', () => {
    expect([...TIMELINE_ENTRY_FIELDS]).toEqual([
      'at',
      'seq',
      'event_type',
      'words_key',
      'actor',
      'channel',
      'amount_minor',
      'state_from',
      'state_to',
      'source',
      'verified',
    ]);
  });
  it('every fixture has the required fields and nothing outside the list', () => {
    expect(TIMELINE_FIXTURES.length).toBeGreaterThanOrEqual(5);
    for (const e of TIMELINE_FIXTURES) {
      for (const k of Object.keys(e)) expect(TIMELINE_ENTRY_FIELDS).toContain(k);
      for (const k of [
        'at',
        'seq',
        'event_type',
        'words_key',
        'actor',
        'channel',
        'source',
        'verified',
      ])
        expect(e, k).toHaveProperty(k);
      expect(Object.keys(e.actor).sort()).toEqual(['kind', 'label']);
      expect(Object.keys(e.source).sort()).toEqual(['id', 'table']);
    }
  });
  it('a fixture carries no buyer identity, provider id or secret', () => {
    expect(JSON.stringify(TIMELINE_FIXTURES)).not.toMatch(
      /@|buyer_id|capture_id|provider_order_id|api_key|secret|ip_hash/,
    );
  });
});

describe('words for actors and channels', () => {
  it('covers every TR0 actor kind and channel', () => {
    expect(Object.keys(ACTOR_WORDS).sort()).toEqual(
      [
        'agent',
        'api_client',
        'buyer',
        'operator',
        'paypal',
        'publisher',
        'system',
        'unattributed',
      ].sort(),
    );
    expect(Object.keys(CHANNEL_WORDS).sort()).toEqual(
      ['api', 'backfill', 'cli', 'job', 'mcp', 'seed', 'web', 'webhook'].sort(),
    );
  });
  it('are plain words with no raw key and no dash', () => {
    for (const w of [...Object.values(ACTOR_WORDS), ...Object.values(CHANNEL_WORDS)]) {
      expect(w).toMatch(/^[A-Z][A-Za-z ]+$/);
      expect(w).not.toMatch(/_/);
    }
  });
});

describe('timelineView', () => {
  it('renders fixtures in time order, then sequence, whatever order they arrive in', () => {
    const shuffled = [...TIMELINE_FIXTURES].reverse();
    const v = timelineView({ entries: shuffled });
    expect(v.kind).toBe('rows');
    if (v.kind !== 'rows') return;
    const keys = v.rows.map((r) => `${r.at}#${r.seq}`);
    expect(keys).toEqual([...keys].sort());
    expect(v.rows).toHaveLength(TIMELINE_FIXTURES.length);
  });
  it('breaks a tie on the same instant by sequence', () => {
    const base: TimelineEntryView = { ...TIMELINE_FIXTURES[0]! };
    const a = { ...base, seq: 2 };
    const b = { ...base, seq: 1 };
    const v = timelineView({ entries: [a, b] });
    if (v.kind !== 'rows') throw new Error('rows expected');
    expect(v.rows.map((r) => r.seq)).toEqual([1, 2]);
  });
  it('each row names the actor, the channel and the step in words', () => {
    const v = timelineView({ entries: TIMELINE_FIXTURES });
    if (v.kind !== 'rows') throw new Error('rows expected');
    for (const r of v.rows) {
      expect(r.actor_label.length).toBeGreaterThan(0);
      expect(r.actor_word).toBe(ACTOR_WORDS[r.actor_kind]);
      expect(r.channel_word).toBe(CHANNEL_WORDS[r.channel]);
      expect(r.text.length).toBeGreaterThan(3);
      expect(r.text).not.toMatch(/_/);
    }
  });
  it('shows an amount in money words only when the entry has one, and says when a step is unverified', () => {
    const v = timelineView({ entries: TIMELINE_FIXTURES });
    if (v.kind !== 'rows') throw new Error('rows expected');
    const withAmount = TIMELINE_FIXTURES.filter((e) => e.amount_minor !== undefined);
    expect(withAmount.length).toBeGreaterThan(0);
    for (const r of v.rows) expect(typeof r.verified).toBe('boolean');
    const unverified = timelineView({
      entries: [{ ...TIMELINE_FIXTURES[0]!, verified: false }],
    });
    if (unverified.kind !== 'rows') throw new Error('rows expected');
    expect(unverified.rows[0]!.note).toBe('Not yet checked against the record.');
    expect(v.rows.find((r) => r.verified)?.note).toBeNull();
  });
  it('an unknown words_key falls back to the raw key made readable, never a blank', () => {
    const v = timelineView({
      entries: [{ ...TIMELINE_FIXTURES[0]!, words_key: 'brand_new_step' }],
    });
    if (v.kind !== 'rows') throw new Error('rows expected');
    expect(v.rows[0]!.text).toBe('Brand new step');
  });
  it('has an empty state in words', () => {
    expect(timelineView({ entries: [] })).toEqual({
      kind: 'empty',
      message: 'Nothing has happened on this order yet.',
    });
  });
  it('has an error state that shows no raw error text', () => {
    const v = timelineView({ error: 'Error: connect ECONNREFUSED 10.0.0.5:5432\n at pg' });
    expect(v).toEqual({
      kind: 'error',
      message: 'The history could not be loaded. Try again in a moment.',
    });
  });
  it('says so when the list is cut off, as TR1 does at 500 entries', () => {
    const v = timelineView({ entries: TIMELINE_FIXTURES, truncated: true });
    if (v.kind !== 'rows') throw new Error('rows expected');
    expect(v.truncated).toBe('Showing the first 500 steps.');
    const full = timelineView({ entries: TIMELINE_FIXTURES });
    if (full.kind !== 'rows') throw new Error('rows expected');
    expect(full.truncated).toBeNull();
  });
});
