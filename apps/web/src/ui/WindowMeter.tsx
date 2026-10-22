import { formatDateTime } from '../lib/format';

const TOTAL_DAYS = 5;

// Shows the access window as words first and a bar second (not colour alone, WCAG 1.4.1).
export function WindowMeter({
  state,
  daysLeft,
  endsAt,
}: {
  state: string;
  daysLeft: number | null;
  endsAt: string | null;
}) {
  if (state === 'running' && daysLeft !== null) {
    const used = Math.min(TOTAL_DAYS, Math.max(0, TOTAL_DAYS - daysLeft));
    return (
      <div className="meter" data-testid="window-meter">
        <p>
          <strong>{daysLeft === 1 ? '1 day left' : `${daysLeft} days left`}</strong>
          {endsAt ? <span className="muted"> until {formatDateTime(endsAt)}</span> : null}
        </p>
        <div className="meter-bar" role="img" aria-label={`${used} of ${TOTAL_DAYS} days used`}>
          <span style={{ width: `${(used / TOTAL_DAYS) * 100}%` }} />
        </div>
      </div>
    );
  }
  const text =
    state === 'not_started'
      ? 'Your 5 days start when payment is confirmed and the content is ready.'
      : state === 'paused'
        ? 'Paused while we fix a delivery problem. You do not lose time.'
        : state === 'ended'
          ? 'The access window has ended.'
          : 'Access was revoked.';
  return (
    <p className="muted" data-testid="window-meter">
      {text}
    </p>
  );
}
