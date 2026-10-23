import type { OutboundGate } from '@umsbx/contracts';

// The low-level Wire: the one seam between the sandbox transport and the network (B-L1).
// The transport decides WHAT may be sent (egress guard, outbound gate, header rules); a Wire only
// moves bytes. Tests use a fake Wire; the production Wire is wire-https.ts, imported by sandbox.ts
// alone.

export type WireErrorKind =
  'timeout' | 'dns' | 'connect' | 'tls' | 'reset' | 'redirect' | 'too_large' | 'aborted' | 'other';

export interface WireRequest {
  method: 'GET' | 'POST';
  /** Absolute https URL: the guard-normalised `url.href`, never the caller's spelling. */
  url: string;
  /** Lower-case names, allow-listed by the transport. No Host: the Wire derives it from `url`. */
  headers: Record<string, string>;
  body: string | null;
  /** Hard total deadline for the whole exchange, in milliseconds. */
  timeout_ms: number;
}

export type WireResult =
  | { kind: 'response'; status: number; headers: Record<string, string>; body: string }
  | { kind: 'error'; error: WireErrorKind };

export interface Wire {
  request(r: WireRequest): Promise<WireResult>;
}

/**
 * An outbound gate that can also say which approval it stands on. The approved sandbox transport
 * is built only from one that reports an active approval for its scope (CLAUDE.md rule 2).
 */
export interface ScopedGate extends OutboundGate {
  activeApproval(): Promise<{ scope: string; approval_ref: string } | null>;
}
