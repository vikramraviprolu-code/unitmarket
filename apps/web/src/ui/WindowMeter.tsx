import { formatDateTime } from '../lib/format';
import { windowUntilLine } from '../lib/buyer-copy';

const TOTAL_DAYS = 5;

// The fill is a class, not a style attribute (the CSP forbids inline style): .meter-fill-1 to .meter-fill-5
// are 20 to 100 percent. Whole days only; no class means an empty bar.
const fillClass = (used: number): string => {
  const days = Math.round(used);
  return days > 0 ? `meter-fill-${Math.min(TOTAL_DAYS, days)}` : '';
};

// Shows the access window as words first and a bar second (not colour alone, WCAG 1.4.1). The time left
// is said once, by the library status line above it; this says only when the window ends (UX-1A, U1).
export function WindowMeter({
  state,
  daysLeft,
  endsAt,
  option,
}: {
  state: string;
  daysLeft: number | null;
  endsAt: string | null;
  option?: string;
}) {
  if (state === 'running' && daysLeft !== null) {
    const used = Math.min(TOTAL_DAYS, Math.max(0, TOTAL_DAYS - daysLeft));
    return (
      <div className="meter" data-testid="window-meter">
        {endsAt ? <p className="muted">{windowUntilLine(option, formatDateTime(endsAt))}</p> : null}
        <div className="meter-bar" role="img" aria-label={`${used} of ${TOTAL_DAYS} days used`}>
          <span className={fillClass(used)} />
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
