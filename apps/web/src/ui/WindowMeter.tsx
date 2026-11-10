import { formatDateTime } from '../lib/format';
import { meterFill, meterTotalDays, windowUntilLine } from '../lib/buyer-copy';

// The fill is a class, not a style attribute (the CSP forbids inline style): .meter-fill-1 to .meter-fill-5
// are 20 to 100 percent of the window's own length (lib/buyer-copy.ts meterFill). No class means an empty bar.
const fillClass = (used: number, total: number): string => {
  const step = meterFill(used, total);
  return step > 0 ? `meter-fill-${step}` : '';
};

// Shows the access window as words first and a bar second (not colour alone, WCAG 1.4.1). The time left
// is said once, by the library status line above it; this says only when the window ends (UX-1A, U1).
export function WindowMeter({
  state,
  daysLeft,
  endsAt,
  startedAt,
  option,
}: {
  state: string;
  daysLeft: number | null;
  endsAt: string | null;
  startedAt?: string | null;
  option?: string;
}) {
  if (state === 'running' && daysLeft !== null) {
    const total = meterTotalDays(startedAt, endsAt);
    const used = Math.min(total, Math.max(0, total - daysLeft));
    return (
      <div className="meter" data-testid="window-meter">
        {endsAt ? <p className="muted">{windowUntilLine(option, formatDateTime(endsAt))}</p> : null}
        <div className="meter-bar" role="img" aria-label={`${used} of ${total} days used`}>
          <span className={fillClass(used, total)} />
        </div>
      </div>
    );
  }
  const text =
    state === 'not_started'
      ? 'Your access window starts when payment is confirmed and the content is ready.'
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
