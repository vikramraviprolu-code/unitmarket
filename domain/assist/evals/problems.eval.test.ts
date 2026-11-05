// INT-GA / GA.5: thirty problem orders on the scripted model. Together they hold every AL alert kind at least twice
// (so every kind with a fix, and every critical and high kind twice, R2-1). The safe action must be right on at
// least 27. Fix ids come from AL's catalogue in severity order, as the composition builds them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALERT_KINDS, describeAlert, severityOf } from '@umsbx/alerts';
import { createScriptedModel } from '@umsbx/model';
import { explainOrder, orderFixIds } from '../src/index';
import type { ExplainEntry } from '../src/index';
import type { OpsTimelineEntry } from '@umsbx/contracts';

interface Case {
  id: string;
  note: string;
  entries: ExplainEntry[];
  alert_kinds: string[];
  expect_action_id: string;
}
const here = fileURLToPath(new URL('.', import.meta.url));
const doc = JSON.parse(readFileSync(join(here, 'problems.json'), 'utf8')) as { cases: Case[] };

// The kinds with a fix in the catalogue, as the composition derives them. Every kind has one today.
const withFix = ALERT_KINDS.filter(
  (k) =>
    describeAlert(
      k,
      k === 'refund_unresolved'
        ? 'refund_outcome_unknown_x'
        : k === 'mandate_near_cap'
          ? 'cap90_x'
          : k === 'webhook_failing'
            ? 'webhook_failing_x'
            : 'x',
    )?.fix !== undefined,
);
const FIX_IDS = orderFixIds(withFix, severityOf);

/** An entry list in the projected shape, turned back into the operator entry explainOrder takes. */
const asEntries = (es: ExplainEntry[]): OpsTimelineEntry[] =>
  es.map((e) => ({
    at: '2026-11-05T10:00:00.000Z',
    seq: e.seq,
    event_type: e.event_type,
    words_key: e.words_key,
    actor: { kind: e.actor_kind as OpsTimelineEntry['actor']['kind'], label: 'x' },
    channel: e.channel as OpsTimelineEntry['channel'],
    ...(e.state_from === null ? {} : { state_from: e.state_from }),
    ...(e.state_to === null ? {} : { state_to: e.state_to }),
    source: { table: 'orders', id: 'src_eval' },
    verified: true,
  }));

describe('GA.5 explain eval (scripted model)', () => {
  it('has thirty cases with unique ids', () => {
    expect(doc.cases).toHaveLength(30);
    expect(new Set(doc.cases.map((c) => c.id)).size).toBe(30);
  });

  it('every alert kind has a fix and is held by at least two cases', () => {
    expect(FIX_IDS.sort()).toEqual([...ALERT_KINDS].sort());
    for (const k of ALERT_KINDS)
      expect(doc.cases.filter((c) => c.alert_kinds.includes(k)).length, k).toBeGreaterThanOrEqual(
        2,
      );
  });

  it('every expected action is a fix id or none', () => {
    for (const c of doc.cases) expect([...FIX_IDS, 'none'], c.id).toContain(c.expect_action_id);
  });

  it('the safe action is right on at least 27 of 30', async () => {
    const model = createScriptedModel();
    const ordered = orderFixIds(withFix, severityOf);
    let right = 0;
    for (const c of doc.cases) {
      const r = await explainOrder(asEntries(c.entries), c.alert_kinds, ordered, model);
      if (r.action_id === c.expect_action_id) right += 1;
      else
        console.log(
          `GA.5 miss ${c.id} (${c.note}): want ${c.expect_action_id}, got ${r.action_id}`,
        );
      expect(r.what_happened.length).toBeGreaterThan(0);
      expect(r.safe_now.length).toBeGreaterThan(0);
    }
    console.log(`GA.5 right ${right}/30`);
    expect(right).toBeGreaterThanOrEqual(27);
  });
});
