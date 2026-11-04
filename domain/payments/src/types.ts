// Types of lane 05a (payments core, part 1). Contract types come from @umsbx/contracts.
import type {
  AccessState,
  EnvironmentLabel,
  Id,
  OrderStatus,
  SqlExecutor,
  WindowState,
} from '@umsbx/contracts';
import type { VerifyError } from '@umsbx/approval';
import type { ProviderOrderState } from './composite';

export type PlaceError =
  | { code: 'approval'; error: VerifyError }
  | { code: 'order_open'; http: 409 }
  | { code: 'already_owned'; http: 409 }
  | { code: 'payee_unavailable'; http: 409 }
  | { code: 'checkout_off'; http: 503 }
  // API-B: an agent purchase the mandate did not take (cap, expiry, currency, ...). Nothing was written.
  | { code: 'mandate_refused'; reason: string; http: 409 };

/**
 * API-B: books an agent purchase against its mandate inside the order transaction. `reserve` runs after the
 * approval is verified and before it is used; if the order is refused after that, `release` gives the room back
 * in the same transaction. `attach` ties the reservation to the order once it exists.
 */
export interface OrderHold {
  mandate_id: string;
  reserve(
    tx: SqlExecutor,
    i: { amount_minor: number; currency: string },
  ): Promise<{ ok: true; reservation_id: string } | { ok: false; reason: string }>;
  attach(tx: SqlExecutor, reservation_id: string, order_id: string): Promise<void>;
  release(tx: SqlExecutor, reservation_id: string): Promise<void>;
}

export interface OrderView {
  order_id: Id;
  order_ref: Id;
  status: OrderStatus;
  /** Plain words for the buyer; never internals. */
  buyer_message: string;
  /** Operator-only detail (F-4): the PayPal reason code of a pending unit. Never shown to a buyer. */
  operator_note: string | null;
  items: { article_id: Id; publisher_id: Id; access: AccessState; window: WindowState }[];
  environment: EnvironmentLabel;
  /** Set when the buyer must go back to PayPal (payer action required, or the order awaits approval). */
  approve_url: string | null;
  /**
   * "Step k of N": which PayPal order the buyer approves next. Null for a single-publisher order and
   * whenever the buyer has nothing left to approve.
   */
  progress: { step: number; of: number } | null;
  /** The PayPal orders of the order by position, with our state for each (never PayPal's ids). */
  provider_orders: { position: number; publisher_id: Id | null; state: ProviderOrderState }[];
}

/** Evidence from the delivery readiness probe, gathered before the transaction. */
export interface ReadinessEvidence {
  article_id: Id;
  content_sha256: string;
  link_probe: 'ok';
}

/**
 * Facts that need I/O outside the database transaction: the unlock switch and the readiness probe
 * of every item. Gathered by readApplyGates before applyReadback opens its transaction. Without
 * gates nothing starts (fail closed): the verified capture is booked and access stays locked.
 */
export interface ApplyGates {
  unlock_enabled: boolean;
  readiness: ReadinessEvidence[];
  /** Items whose readiness probe failed, with the probe's code. */
  not_ready: { article_id: Id; code: string }[];
}

export interface ApplyReport {
  order_status: OrderStatus;
  /** Entitlement ids whose access started in this call. */
  unlocked: Id[];
  /** Order unit ids. */
  pending: Id[];
  declined: Id[];
  mismatched: Id[];
  /** Alert kinds newly raised by this call. */
  alerts: string[];
}
