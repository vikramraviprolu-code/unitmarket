// CO-2 golden: the fixed outputs of webhook intake against hand-written files in golden/: the
// event-type to target table, the verdict to answer table and the audit row of a refused delivery.
// A change to a file is a change to the rules.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderEventTypeSchema } from '@umsbx/contracts';
import type { ProviderEvent, SqlExecutor, WebhookVerdict } from '@umsbx/contracts';
import { handleWebhook } from './index';
import { makeWorld, paid } from './ops/support';
import type { OpsWorld } from './ops/support';
import { targetsOf } from './webhooks';

const golden = (name: string): string[] =>
  readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('#'));

let w: OpsWorld;
afterEach(async () => {
  await w?.close();
});

let seq = 0;
const ev = (type: ProviderEvent['type'], o: Partial<ProviderEvent> = {}): ProviderEvent => ({
  event_id: `WH-GOLD-${(seq += 1)}`,
  transmission_id: `tx-gold-${seq}`,
  type,
  provider_order_id: null,
  capture_id: null,
  refund_id: null,
  occurred_at: '2026-10-22T10:00:00.000Z',
  ...o,
});

describe('webhook intake (golden)', () => {
  it('event type to target matches golden/webhook-targets.golden.txt', () => {
    const cell = (t: ReturnType<typeof targetsOf>): string =>
      t.length === 0 ? '-' : t.map((x) => x.by).join('>');
    const ids = { capture_id: 'CAP1', refund_id: 'REF1', provider_order_id: 'ORD1' };
    const lines = [
      'type | capture_id only | refund_id only | capture_id and refund_id | provider_order_id only | all three',
    ];
    for (const type of ProviderEventTypeSchema.options) {
      lines.push(
        [
          type,
          cell(targetsOf(ev(type, { capture_id: ids.capture_id }))),
          cell(targetsOf(ev(type, { refund_id: ids.refund_id }))),
          cell(targetsOf(ev(type, { capture_id: ids.capture_id, refund_id: ids.refund_id }))),
          cell(targetsOf(ev(type, { provider_order_id: ids.provider_order_id }))),
          cell(targetsOf(ev(type, ids))),
        ].join(' | '),
      );
    }
    expect(lines).toEqual(golden('webhook-targets.golden.txt'));
  });

  it('verdict and switch to the answer matches golden/webhook-responses.golden.txt', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const capture_id = (
      await w.rows<{ capture_id: string }>(
        'SELECT capture_id FROM order_units WHERE order_id = $1',
        [a.order_id],
      )
    )[0]!.capture_id;
    const send = async (verdict: WebhookVerdict): Promise<string> => {
      const r = await handleWebhook(w.deps, {
        verdict,
        transmission_id: 'tx-golden',
        received_at: w.clock.now().toISOString(),
      });
      return `${r.http} | ${r.outcome}`;
    };
    const verified = (e: ProviderEvent): WebhookVerdict => ({ kind: 'verified', event: e });
    const lines = ['verdict | webhook_enabled | http | outcome'];
    const known = ev('PAYMENT.CAPTURE.COMPLETED', { capture_id });
    lines.push(
      `verified, capture not ours | on | ${await send(verified(ev('PAYMENT.CAPTURE.COMPLETED', { capture_id: 'NOTOURS1' })))}`,
      `verified, capture ours | on | ${await send(verified(known))}`,
      `verified, same event again | on | ${await send(verified(known))}`,
      `bad_signature | on | ${await send({ kind: 'bad_signature', why: 'signature' })}`,
      `malformed | on | ${await send({ kind: 'malformed' })}`,
      `unverifiable | on | ${await send({ kind: 'unverifiable' })}`,
    );
    w.switches.webhook_enabled = false;
    lines.push(
      `verified | off | ${await send(verified(ev('PAYMENT.CAPTURE.COMPLETED', { capture_id })))}`,
      `bad_signature | off | ${await send({ kind: 'bad_signature', why: 'signature' })}`,
      `malformed | off | ${await send({ kind: 'malformed' })}`,
      `unverifiable | off | ${await send({ kind: 'unverifiable' })}`,
    );
    expect(lines).toEqual(golden('webhook-responses.golden.txt'));
  });

  it('the audit row of a refused delivery matches golden/webhook-audit.golden.txt', async () => {
    w = await makeWorld();
    let n = 0;
    w.deps = {
      ...w.deps,
      audit: {
        record: async (tx: SqlExecutor, e) => {
          n += 1;
          await tx.query(
            `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
             VALUES ($1, $2, NULL, $3, $4, $5, $6::jsonb, $7, $7)`,
            [
              `aud_g${n}`,
              e.actor.kind,
              e.action,
              e.target,
              e.reason,
              JSON.stringify(e.detail),
              w.clock.now().toISOString(),
            ],
          );
        },
      },
    };
    const refuse = (verdict: WebhookVerdict, transmission_id: string) =>
      handleWebhook(w.deps, {
        verdict,
        transmission_id,
        received_at: w.clock.now().toISOString(),
      });
    await refuse({ kind: 'bad_signature', why: 'crc_mismatch' }, 'tx-bad-1');
    await refuse({ kind: 'malformed' }, 'tx-malformed-1');
    await refuse({ kind: 'unverifiable' }, 'tx-unverifiable-1');
    const rows = await w.rows<{
      action: string;
      actor_kind: string;
      target: string | null;
      reason: string | null;
      detail: unknown;
    }>('SELECT action, actor_kind, target, reason, detail FROM audit_log ORDER BY length(id), id');
    const lines = [
      'action | actor_kind | target | reason | detail',
      ...rows.map(
        (r) =>
          `${r.action} | ${r.actor_kind} | ${r.target === null ? 'null' : r.target} | ${r.reason} | ${JSON.stringify(r.detail)}`,
      ),
    ];
    expect(lines).toEqual(golden('webhook-audit.golden.txt'));
  });
});
