'use client';
import {
  INVITE_COPIED_BUTTON,
  INVITE_SHOWN_HEADING,
  INVITE_SHOWN_WARNING,
  inviteExpiresText,
  inviteGroups,
} from '../../../lib/publisher-accounts-copy';

// POB-P1: the one time invite code, on the operator's screen only. It lives in this component's state in the
// browser and nowhere else: the server keeps only a hash, so a reload shows nothing. The operator confirms they
// copied it, and only then does the page refresh.
export function InviteCodePanel({
  code,
  expiresAt,
  onDone,
}: {
  code: string;
  expiresAt: string;
  onDone: () => void;
}) {
  return (
    <div className="pk-invite" role="status" data-testid="invite-panel">
      <h4>{INVITE_SHOWN_HEADING}</h4>
      <p className="pk-invite-code" data-testid="invite-code">
        {inviteGroups(code)}
      </p>
      <p>{INVITE_SHOWN_WARNING}</p>
      <p className="muted">{inviteExpiresText(expiresAt)}</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onDone}>
          {INVITE_COPIED_BUTTON}
        </button>
      </div>
    </div>
  );
}
