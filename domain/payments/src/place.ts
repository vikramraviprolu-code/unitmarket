// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/place.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05a.
// P1: placeOrder. Checks first, then every write, in one transaction. No PayPal call happens here
// or inside any other transaction; the provider is called later by beginCheckout (P14).
import { markUsed, verifyApproval } from '@umsbx/approval';
import { createPendingEntitlements } from '@umsbx/entitlements';
import { ExpectedTransactionSchema, err, ok } from '@umsbx/contracts';
import type {
  Actor,
  ExpectedTransaction,
  Id,
  OrderStatus,
  PaymentsDeps,
  Result,
} from '@umsbx/contracts';
import { requestIdFor } from './keys';
import type { PlaceError } from './types';
import { addMs } from './store';

// Orders that no longer block a new order for the same buyer and content (the unique partial index
// orders_one_open_per_buyer_hash lists the same set).
const CLOSED = "('paid', 'paid_partial', 'failed', 'abandoned')";

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';

export async function placeOrder(
  d: PaymentsDeps,
  i: { approval_id: Id; token: string; actor: Actor },
): Promise<Result<{ order_id: Id; order_ref: Id; status: OrderStatus }, PlaceError>> {
  // The switch is read before the transaction: the port may use the database itself.
  if (!(await d.switches.isOn('checkout_enabled'))) {
    return err({ code: 'checkout_off', http: 503 });
  }
  try {
    return await d.db.transaction(
      async (
        tx,
      ): Promise<Result<{ order_id: Id; order_ref: Id; status: OrderStatus }, PlaceError>> => {
        const verified = await verifyApproval(tx, d, i);
        if (!verified.ok) return err({ code: 'approval', error: verified.error });
        const approval = verified.value;
        const snapshot = approval.snapshot;

        const open = await tx.query(
          `SELECT id FROM orders WHERE buyer_id = $1 AND content_hash = $2 AND status NOT IN ${CLOSED} LIMIT 1`,
          [approval.buyer_id, approval.content_hash],
        );
        if (open.rows.length > 0) return err({ code: 'order_open', http: 409 });
        const used = await markUsed(tx, d, { approval_id: i.approval_id });
        if (!used.ok) {
          return err({ code: 'approval', error: { code: 'already_used', http: 409 } });
        }

        const at = d.clock.now().toISOString();
        const order_id = d.ids.next('ord');
        const order_ref = d.ids.next('ord');
        const publishers = [...snapshot.publishers].sort((a, b) =>
          a.publisher_id < b.publisher_id ? -1 : a.publisher_id > b.publisher_id ? 1 : 0,
        );
        const unitIds = new Map<string, Id>();
        for (const p of publishers) unitIds.set(p.publisher_id, d.ids.next('unt'));

        // The expected transaction is built from the frozen snapshot and parsed; it is never
        // rebuilt from anything PayPal says.
        const expected: ExpectedTransaction = ExpectedTransactionSchema.parse({
          order_ref,
          buyer_id: approval.buyer_id,
          content_hash: approval.content_hash,
          currency: snapshot.currency,
          total_minor: snapshot.total_minor,
          units: publishers.map((p) => ({
            reference_id: unitIds.get(p.publisher_id),
            publisher_id: p.publisher_id,
            payee_merchant_id: p.payee_merchant_id,
            amount_minor: p.amount_minor,
          })),
          created_at: at,
          environment: d.environment,
        });

        await tx.query(
          `INSERT INTO orders (id, approval_id, buyer_id, content_hash, order_ref, expected, status, mismatch,
             corridor_id, currency, total_minor, environment, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'created', false, $7, $8, $9, $10, $11, $11)`,
          [
            order_id,
            approval.approval_id,
            approval.buyer_id,
            approval.content_hash,
            order_ref,
            JSON.stringify(expected),
            snapshot.corridor_id,
            snapshot.currency,
            snapshot.total_minor,
            d.environment,
            at,
          ],
        );
        // MVP-A: one PayPal order for the whole approval (route single). The per-publisher route
        // (several rows here) belongs to MVP-D.
        const provider_row = d.ids.next('pvo');
        await tx.query(
          `INSERT INTO provider_orders (id, order_id, provider_order_id, route, approve_url, status, created_at, updated_at)
           VALUES ($1, $2, NULL, 'single', NULL, NULL, $3, $3)`,
          [provider_row, order_id, at],
        );
        for (const p of publishers) {
          const unit_id = unitIds.get(p.publisher_id) as Id;
          await tx.query(
            `INSERT INTO order_units (id, order_id, provider_order_ref, publisher_id, reference_id, payee_merchant_id,
               amount_minor, platform_fee_minor, capture_id, status, status_reason, paypal_fee_minor, refunded_minor,
               captured_verified_at, mismatch_reason, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $1, $5, $6, $7, NULL, 'expected', NULL, NULL, 0, NULL, NULL, $8, $8)`,
            [
              unit_id,
              order_id,
              provider_row,
              p.publisher_id,
              p.payee_merchant_id,
              p.amount_minor,
              p.platform_fee_minor,
              at,
            ],
          );
          const items = snapshot.items
            .filter((item) => item.publisher_id === p.publisher_id)
            .sort((a, b) =>
              a.article_id < b.article_id ? -1 : a.article_id > b.article_id ? 1 : 0,
            );
          await createPendingEntitlements(tx, d, {
            buyer_id: approval.buyer_id,
            unit_id,
            items: items.map((item) => ({
              article_id: item.article_id,
              option: item.option,
              policy: item.policy,
            })),
          });
        }
        await tx.query(
          `INSERT INTO operations (id, order_id, unit_id, kind, state, attempt, request_id, first_sent_at, idem_safe_until,
             lease_until, next_retry_at, reconcile_until, failure_reason, created_at, updated_at)
           VALUES ($1, $2, NULL, 'create', 'prepared', 1, $3, NULL, NULL, $4, NULL, NULL, NULL, $5, $5)`,
          [
            d.ids.next('opr'),
            order_id,
            requestIdFor('create', order_ref),
            addMs(at, d.config.operation_lease_ms),
            at,
          ],
        );
        await d.audit.record(tx, {
          actor: i.actor,
          action: 'order.placed',
          target: order_id,
          reason: null,
          detail: { order_ref, total_minor: snapshot.total_minor, currency: snapshot.currency },
        });
        return ok({ order_id, order_ref, status: 'created' });
      },
    );
  } catch (e) {
    // Two requests with the same content raced past the check: the database decided (P10).
    if (isUniqueViolation(e)) return err({ code: 'order_open', http: 409 });
    throw e;
  }
}
