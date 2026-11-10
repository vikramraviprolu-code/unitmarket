// POB-I1 (D-089): the ports and shared types of the web import. No behaviour. The fetcher is a port: the
// real one lives in packages/transport and is chosen by composition; a test hands in a scripted web.
import type { CoreDeps } from '@umsbx/contracts';
import type { ImportFeePolicy } from './import-fee';

export type ImportFetchOutcome =
  | { ok: true; body: string; bytes: Uint8Array; content_type: string; host: string }
  | { ok: false; reason: string };

export interface ImportFetchOptions {
  /** The hosts this call may reach: the publisher's verified domain, or the host whose proof is being checked. */
  allow: readonly string[];
  /** Default text. An image is jpeg, png or webp, 2 MB at most, and comes back as bytes. */
  kind?: 'text' | 'image';
}

/** What the import needs from a fetcher. The transport package's FeedFetcher satisfies it. */
export interface ImportFetcherPort {
  fetch(url: string, o: ImportFetchOptions): Promise<ImportFetchOutcome>;
}

export type ImportDeps = Pick<CoreDeps, 'db' | 'clock' | 'ids' | 'audit'> & {
  /** UMS_OFFER_MAX_MINOR: the cap of any offer price. */
  offer_max_minor: number;
  /** Null while the feature is off: every call that would fetch answers import_off. */
  fetcher: ImportFetcherPort | null;
  /**
   * Asked before EVERY fetch (the web_import_enabled switch and maintenance, never paypal_outbound). False ends the run as interrupted,
   * a throw ends it as failed.
   */
  mayFetch: () => Promise<boolean>;
  /** The buyer price shown at review is the publisher price plus this fee. Never stored on an item. */
  fee: ImportFeePolicy;
  /**
   * POB-G: reads the fee setting each time it is called (composition wires the fee lane here). When present it is used
   * instead of `fee`; when it throws the review shows no buyer price and publish answers fee_unavailable.
   */
  loadFee?: () => Promise<ImportFeePolicy>;
};

export type ImportErrorCode =
  | 'not_publisher'
  | 'publisher_not_active'
  | 'invalid_input'
  | 'invalid_host'
  | 'invalid_address'
  | 'host_taken'
  | 'too_many_domains'
  | 'domain_not_verified'
  | 'proof_missing'
  | 'proof_refused'
  | 'proof_lost'
  | 'import_off'
  | 'paused'
  | 'import_active'
  | 'no_corridor'
  | 'not_found'
  | 'not_editable'
  | 'invalid_title'
  | 'invalid_price'
  | 'attestation_required'
  | 'batch_not_ready'
  | 'fee_unavailable';

export interface ImportError {
  code: ImportErrorCode;
  /** A fixed word (a refusal kind of the fetcher). Never text from a site. */
  detail?: string;
}
