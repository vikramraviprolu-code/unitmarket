// INT-TR0 / TR0.1: the allow-list. The golden list in trace.ts and the trace_tracked rows that the
// migration writes are the only source of what the journal copies; this test pins both to the spec table
// and to each other. The migration is read as text (contracts imports no other package, so it cannot open
// the database); packages/db/src/trace-capture.state.test.ts compares the table itself after migrating.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTOR_KINDS, CHANNELS, TRACKED_TABLES, UA_FAMILIES } from './trace';

const MIGRATIONS = new URL('../../db/migrations/common/', import.meta.url);

interface SeedRow {
  table: string;
  copied: string[];
  hashed: string[];
  digest: string[];
  time: string;
  chain: string;
}

const list = (s: string): string[] =>
  s.trim() === '' ? [] : s.split(',').map((x) => x.trim().replace(/^'|'$/g, ''));

// The journal migration seeds the first rows. A later lane that adds a tracked table (BR-2, AL, CTL) writes
// its own row in the same line format inside its own migration, so every migration file is read and the
// rows are compared by table name.
function seedRowsOfMigration(): SeedRow[] {
  const journal = readdirSync(MIGRATIONS).find((f) => /^\d{4}_trace_journal\.sql$/.test(f));
  expect(journal, 'the trace journal migration exists').toBeDefined();
  const out: SeedRow[] = [];
  const row =
    /^\s*\('([a-z_]+)', ARRAY\[([^\]]*)\](?:::text\[\])?, ARRAY\[([^\]]*)\](?:::text\[\])?, ARRAY\[([^\]]*)\](?:::text\[\])?, '([a-z_]+)', '([^']+)'\),?\s*$/gm;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(new URL(file, MIGRATIONS), 'utf8');
    for (const m of sql.matchAll(row)) {
      out.push({
        table: m[1]!,
        copied: list(m[2]!),
        hashed: list(m[3]!),
        digest: list(m[4]!),
        time: m[5]!,
        chain: m[6]!,
      });
    }
  }
  return out.sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
}

describe('TR0.1 enums', () => {
  it('actor kinds, channels and user agent families are the spec lists', () => {
    expect([...ACTOR_KINDS]).toEqual([
      'buyer',
      'publisher',
      'operator',
      'agent',
      'api_client',
      'system',
      'paypal',
      'unattributed',
    ]);
    expect([...CHANNELS]).toEqual([
      'web',
      'api',
      'mcp',
      'job',
      'webhook',
      'cli',
      'seed',
      'backfill',
    ]);
    expect([...UA_FAMILIES]).toEqual(['browser', 'curl', 'sdk', 'other']);
  });
});

describe('TR0.1 the golden allow-list', () => {
  it('names the 28 tracked tables (27 of the spec and rule_settings, BR-2), once each, in name order', () => {
    expect(TRACKED_TABLES.map((t) => t.table)).toEqual([
      'access_events',
      'access_windows',
      'alerts',
      'api_keys',
      'approvals',
      'audit_log',
      'entitlements',
      'ledger_entries',
      'links',
      'mandate_reservations',
      'mandates',
      'offers',
      'operations',
      'order_units',
      'orders',
      'outbound_approvals',
      'payee_decisions',
      'provider_calls',
      'provider_orders',
      'publisher_applicant_decisions',
      'publishers',
      'receipts',
      'recovery_actions',
      'recovery_cases',
      'refund_requests',
      'rule_settings',
      'safety_switches',
      'webhook_events',
    ]);
  });

  it('pins the copied, hashed, time and chain columns of the spec table', () => {
    const by = Object.fromEntries(TRACKED_TABLES.map((t) => [t.table, t]));
    expect(by['orders']).toMatchObject({
      copied: ['status', 'total_minor', 'currency', 'corridor_id', 'order_ref', 'environment'],
      hashed: ['expected'],
      time: 'updated_at',
      chain: 'ord:id',
    });
    expect(by['order_units']).toMatchObject({
      copied: [
        'status',
        'amount_minor',
        'platform_fee_minor',
        'paypal_fee_minor',
        'refunded_minor',
        'capture_id',
        'captured_verified_at',
        'status_reason',
        'mismatch_reason',
      ],
      hashed: ['payee_merchant_id'],
    });
    expect(by['mandates']).toMatchObject({
      copied: [
        'max_total_minor',
        'max_count',
        'max_per_purchase_minor',
        'expires_at',
        'revoked_at',
        'spent_minor',
        'used_count',
        'exhausted_at',
      ],
      chain: 'mdt:id',
    });
    expect(by['api_keys']).toMatchObject({
      copied: ['key_kind', 'scopes', 'revoked_at'],
      chain: 'key:id',
    });
    expect(by['safety_switches']).toMatchObject({
      copied: ['on', 'changed_at'],
      hashed: ['reason', 'changed_by'],
      chain: 'plat',
    });
    expect(by['audit_log']).toMatchObject({
      copied: ['actor_kind', 'actor_id', 'action', 'target'],
      hashed: ['reason', 'detail'],
      chain: 'plat',
    });
    expect(by['ledger_entries']!.hashed).toEqual([]);
    expect(by['links']!.copied).not.toContain('token_hash');
  });

  it('copies no free text, no secret and no jsonb detail: those columns are hashed or left out', () => {
    const NEVER_COPIED = [
      'reason',
      'buyer_message',
      'detail',
      'evidence',
      'snapshot',
      'resource',
      'request_redacted',
      'response_redacted',
      'body',
      'expected',
      'policy',
      'note',
      'changed_by',
      'approved_by',
      'token_hash',
      'secret_hash',
      'nonce',
      'transition_log',
      'paypal_merchant_id',
      'payee_merchant_id',
      'option',
    ];
    for (const t of TRACKED_TABLES) {
      for (const c of t.copied) {
        expect(NEVER_COPIED, `${t.table}.${c} is copied as a value`).not.toContain(c);
      }
      expect(new Set([...t.copied, ...t.hashed]).size).toBe(t.copied.length + t.hashed.length);
    }
    const everything = TRACKED_TABLES.flatMap((t) => [...t.copied, ...t.hashed]);
    expect(everything).not.toContain('token_hash');
    expect(everything).not.toContain('secret_hash');
    expect(everything).not.toContain('nonce');
    expect(everything).not.toContain('transition_log');
  });

  it('gives a frozen digest column list to the nine append-only tables and to no other', () => {
    const withDigest = TRACKED_TABLES.filter((t) => t.digest.length > 0).map((t) => t.table);
    expect(withDigest).toEqual([
      'access_events',
      'audit_log',
      'ledger_entries',
      'payee_decisions',
      'provider_calls',
      'publisher_applicant_decisions',
      'receipts',
      'recovery_actions',
      'rule_settings',
    ]);
    for (const t of TRACKED_TABLES.filter((x) => x.digest.length > 0)) {
      expect(t.digest).toContain('id');
    }
    expect(TRACKED_TABLES.find((t) => t.table === 'ledger_entries')!.digest).toEqual([
      'id',
      'unit_id',
      'capture_id',
      'kind',
      'amount_minor',
      'currency',
      'refund_id',
      'ref_entry_id',
      'environment',
      'created_at',
      'updated_at',
    ]);
  });
});

describe('TR0.1 the migration writes exactly the golden list', () => {
  it('trace_tracked seed rows equal TRACKED_TABLES, column by column', () => {
    const seeded = seedRowsOfMigration();
    expect(seeded).toEqual(
      [...TRACKED_TABLES]
        .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0))
        .map((t) => ({
          table: t.table,
          copied: [...t.copied],
          hashed: [...t.hashed],
          digest: [...t.digest],
          time: t.time,
          chain: t.chain,
        })),
    );
  });
});
