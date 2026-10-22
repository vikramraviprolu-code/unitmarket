// Error codes of lane 06. Expected failures are values (Result), never exceptions.
export type ApprovalError = {
  code:
    | 'unknown_selection'
    | 'quote_expired'
    | 'offer_changed'
    | 'publisher_unverified'
    | 'mixed_currency'
    | 'corridor_unsupported'
    | 'consent_missing'
    | 'not_owner'
    | 'too_many_items';
};

export type VerifyError =
  | { code: 'unknown_approval'; http: 404 }
  | { code: 'bad_token'; http: 403 }
  | { code: 'expired'; http: 410 }
  | { code: 'already_used'; http: 409 }
  | { code: 'not_owner'; http: 404 }
  | { code: 'snapshot_tampered'; http: 403 };

export const approvalError = (
  code: ApprovalError['code'],
): { ok: false; error: ApprovalError } => ({
  ok: false,
  error: { code },
});
