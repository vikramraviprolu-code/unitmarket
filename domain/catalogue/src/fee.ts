// The fee on top (POB-M1, D-089). The buyer pays the publisher's price plus UnitMarket's fee. The fee is a share of the
// publisher's price in basis points (0 to 3000, that is 0 to 30 percent), rounded half away from zero. The offer's listed
// price IS the buyer price, so quotes, approvals, orders, browse and discovery read it exactly as before; the split is
// stored beside it (offer_price_parts) and carried to the ledger at capture.
//
// This is the one place the rule lives: `applyFee` is the function every caller uses, and `FeePolicy` is the port the web
// import (POB-I1) calls at publish. Pure functions here; the setting itself is a row (fee_settings), read and written below.
import { FEE_BPS_MAX, FeeBpsSchema, err, ok } from '@umsbx/contracts';
import type { Actor, CoreDeps, Id, Result, SqlExecutor } from '@umsbx/contracts';

export { FEE_BPS_MAX };

export interface FeeSplit {
  seller_minor: number;
  fee_minor: number;
  buyer_minor: number;
}

/** The split of one price, with the rate it was made at. `tax_minor` is a reserved field, always 0 (not built). */
export interface FeeParts extends FeeSplit {
  fee_bps: number;
  tax_minor: 0;
}

/**
 * The fee of a publisher price: seller_minor * fee_bps / 10000, rounded half away from zero. Exact (integer arithmetic).
 * A zero rate gives buyer equals seller. Throws RangeError for a rate that is not a whole number from 0 to 3000, a price
 * that is not a whole number of minor units from 0 to the largest safe integer, or a buyer price that would not be one.
 */
export function applyFee(seller_minor: number, fee_bps: number): FeeSplit {
  if (!Number.isSafeInteger(fee_bps) || fee_bps < 0 || fee_bps > FEE_BPS_MAX) {
    throw new RangeError(
      `applyFee: the fee must be a whole number of basis points from 0 to ${String(FEE_BPS_MAX)}`,
    );
  }
  if (!Number.isSafeInteger(seller_minor) || seller_minor < 0) {
    throw new RangeError('applyFee: the price must be a whole number of minor units, 0 or more');
  }
  // floor((price * bps + 5000) / 10000) is round half up, which is half away from zero for a price of 0 or more.
  const fee = Number((BigInt(seller_minor) * BigInt(fee_bps) + 5000n) / 10000n);
  const buyer = seller_minor + fee;
  if (!Number.isSafeInteger(buyer)) {
    throw new RangeError('applyFee: the buyer price is not a safe whole number');
  }
  return { seller_minor, fee_minor: fee, buyer_minor: buyer };
}

/** The port the web import (POB-I1) and any publish step call. Sync: the rate is read once, then used for a whole batch. */
export interface FeePolicy {
  /** The rate this policy was built at. A policy keeps it; a later setting does not change a policy already loaded. */
  readonly fee_bps: number;
  feeFor(seller_minor: number, currency: string): FeeParts;
}

export function fixedFeePolicy(fee_bps: number): FeePolicy {
  // Checked once, here: a bad rate never builds a policy.
  applyFee(0, fee_bps);
  return {
    fee_bps,
    feeFor(seller_minor, currency) {
      if (!/^[A-Z]{3}$/.test(currency))
        throw new RangeError('FeePolicy: the currency is not three capital letters');
      const s = applyFee(seller_minor, fee_bps);
      return { ...s, fee_bps, tax_minor: 0 };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The setting: fee_settings is append-only and the latest row rules.

export interface FeeSetting {
  id: Id;
  fee_bps: number;
  set_by: string;
  set_at: string;
  reason: string;
}

interface SettingRow {
  id: string;
  fee_bps: number;
  set_by: string;
  reason: string;
  set_at: string;
}
const SETTING_COLUMNS = `id, fee_bps, set_by, reason,
  to_char(set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS set_at`;
const toSetting = (r: SettingRow): FeeSetting => ({
  id: r.id,
  fee_bps: Number(r.fee_bps),
  set_by: r.set_by,
  set_at: r.set_at,
  reason: r.reason,
});

/** The setting in force. Throws when there is none: a missing row is a data problem, never a silent fee of 0. */
export async function currentFee(db: SqlExecutor): Promise<FeeSetting> {
  const r = await db.query<SettingRow>(
    `SELECT ${SETTING_COLUMNS} FROM fee_settings ORDER BY set_at DESC, id DESC LIMIT 1`,
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error('fee_settings is empty: the platform fee is not set');
  return toSetting(row);
}

/** Newest first. `limit` is clamped to 1..500. */
export async function listFeeHistory(db: SqlExecutor, limit = 50): Promise<FeeSetting[]> {
  const n = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 500) : 50;
  const r = await db.query<SettingRow>(
    `SELECT ${SETTING_COLUMNS} FROM fee_settings ORDER BY set_at DESC, id DESC LIMIT $1`,
    [n],
  );
  return r.rows.map(toSetting);
}

/** A policy at the rate in force now. */
export async function loadFeePolicy(db: SqlExecutor): Promise<FeePolicy> {
  return fixedFeePolicy((await currentFee(db)).fee_bps);
}

export type FeeDeps = Pick<CoreDeps, 'db' | 'clock' | 'ids' | 'audit'>;
export type FeeErrorCode =
  'not_operator' | 'mfa_required' | 'fee_invalid' | 'reason_invalid' | 'conflict';
export interface FeeError {
  code: FeeErrorCode;
}
const fail = (code: FeeErrorCode): Result<never, FeeError> => err({ code });

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';

/**
 * Sets the platform fee. An operator with the second factor, a whole number of basis points from 0 to 3000 and a
 * reason of 3 to 200 characters; one new row and one audit event in one transaction. The route checks the same things
 * and this function checks them again, so a bypassed route still cannot write. Does not touch any price already listed
 * or any sale already made: the parts of an offer version and of a unit are copies.
 */
export async function setFee(
  d: FeeDeps,
  i: { actor: Actor; fee_bps: unknown; reason: unknown },
): Promise<Result<{ id: Id; fee_bps: number }, FeeError>> {
  if (i.actor.kind !== 'operator') return fail('not_operator');
  if (i.actor.mfa !== true) return fail('mfa_required');
  const parsed = FeeBpsSchema.safeParse(i.fee_bps);
  if (!parsed.success || !Number.isSafeInteger(parsed.data)) return fail('fee_invalid');
  const bps = parsed.data;
  const reason = typeof i.reason === 'string' ? i.reason.trim() : '';
  if (reason.length < 3 || reason.length > 200) return fail('reason_invalid');
  const actor = i.actor;
  try {
    return await d.db.transaction(async (tx) => {
      const prev = (
        await tx.query<{ fee_bps: number; set_at_ms: string | number }>(
          `SELECT fee_bps, (extract(epoch FROM set_at) * 1000)::bigint AS set_at_ms FROM fee_settings
            ORDER BY set_at DESC, id DESC LIMIT 1`,
        )
      ).rows[0];
      // Strictly after the setting in force, so two settings in one millisecond still have a latest.
      const prevMs = prev === undefined ? Number.NEGATIVE_INFINITY : Number(prev.set_at_ms);
      const at = new Date(Math.max(d.clock.now().getTime(), prevMs + 1)).toISOString();
      const id = d.ids.next('rls');
      await tx.query(
        `INSERT INTO fee_settings (id, fee_bps, set_by, set_at, reason, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $4, $4)`,
        [id, bps, actor.operator_id, at, reason],
      );
      await d.audit.record(tx, {
        actor,
        action: 'fee.set',
        target: id,
        reason,
        detail: {
          fee_bps: bps,
          previous_fee_bps: prev === undefined ? null : Number(prev.fee_bps),
        },
      });
      return ok({ id, fee_bps: bps });
    });
  } catch (e) {
    // Another operator set a fee at the same instant: nothing was written, the caller may try again.
    if (isUniqueViolation(e)) return fail('conflict');
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// The parts of an offer version.

/**
 * Writes the split of one option of an offer version, once. Seller plus fee must equal the listed price of that option
 * (the database checks it against the offer row). Called by the publish step in the same transaction as the offer.
 */
export async function recordOfferParts(
  tx: SqlExecutor,
  d: Pick<CoreDeps, 'clock'>,
  i: { offer_id: Id; offer_version: string; option: string; parts: FeeParts },
): Promise<void> {
  const p = i.parts;
  if (
    p.seller_minor + p.fee_minor !== p.buyer_minor ||
    p.tax_minor !== 0 ||
    !Number.isSafeInteger(p.buyer_minor)
  ) {
    throw new RangeError(
      'recordOfferParts: seller plus fee must equal the buyer price, and tax is 0',
    );
  }
  const at = d.clock.now().toISOString();
  await tx.query(
    `INSERT INTO offer_price_parts (offer_id, offer_version, option, seller_minor, fee_minor, tax_minor, fee_bps, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $7)`,
    [i.offer_id, i.offer_version, i.option, p.seller_minor, p.fee_minor, p.fee_bps, at],
  );
}
