// Types of lane 05a (payments core, part 1). Contract types come from @umsbx/contracts.
import type { AccessState, EnvironmentLabel, Id, OrderStatus, WindowState } from '@umsbx/contracts';
import type { VerifyError } from '@umsbx/approval';

export type PlaceError =
  | { code: 'approval'; error: VerifyError }
  | { code: 'order_open'; http: 409 }
  | { code: 'checkout_off'; http: 503 };

export interface OrderView {
  order_id: Id;
  order_ref: Id;
  status: OrderStatus;
  /** Plain words for the buyer; never internals. */
  buyer_message: string;
  items: { article_id: Id; access: AccessState; window: WindowState }[];
  environment: EnvironmentLabel;
  /** Set when the buyer must go back to PayPal (payer action required, or the order awaits approval). */
  approve_url: string | null;
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
