// The five-day access clock as a pure function of the append-only access_events log
// (architecture 4.4, 9.4). No database, no clock: `now` is an argument.
import type {
  AccessEvent,
  AccessEventKind,
  AccessPolicy,
  AccessState,
  MoneyState,
  WindowState,
} from '@umsbx/contracts';

export const HOUR_MS = 3_600_000;
/** access_windows.credit_ms is a 32-bit column; the total is capped here so it always fits. */
export const MAX_CREDIT_MS = 2_147_483_647;

export function ceilToHour(ms: number): number {
  return ms <= 0 ? 0 : Math.ceil(ms / HOUR_MS) * HOUR_MS;
}

const iso = (ms: number): string => new Date(ms).toISOString();

// Kinds that can move the window, and who may send them. A buyer-sourced event (a client signal)
// never moves the window: the buyer must not be able to pause or extend their own clock.
const RESUME_KINDS: ReadonlySet<AccessEventKind> = new Set([
  'delivery_restored',
  'download_completed',
  'reader_rendered',
]);

function creditOf(e: AccessEvent): number | null {
  const c = e.evidence['credit_ms'];
  return typeof c === 'number' && Number.isSafeInteger(c) && c > 0 ? c : null;
}

export function computeWindow(events: AccessEvent[], policy: AccessPolicy, now: Date): WindowState {
  const ordered = events
    .map((e, index) => ({ e, index, t: Date.parse(e.at) }))
    .sort((a, b) => a.t - b.t || a.index - b.index);

  let state: WindowState['state'] = 'not_started';
  let startedMs: number | null = null;
  let baseEndMs: number | null = null;
  let pausedMs: number | null = null;
  let credit = 0;
  const endsMs = (): number => (baseEndMs ?? 0) + credit;

  for (const { e, t } of ordered) {
    if (state === 'revoked') break;
    // An event that arrives at or after the end finds the window already ended.
    if (state === 'running' && t >= endsMs()) state = 'ended';
    const trusted = e.source !== 'buyer';
    if (!trusted) continue;
    if (e.kind === 'revoked') {
      state = 'revoked';
      pausedMs = null;
      continue;
    }
    if (state === 'ended') continue;
    switch (e.kind) {
      case 'access_ready':
        if (state === 'not_started') {
          state = 'running';
          startedMs = t;
          baseEndMs = t + policy.window_ms;
        }
        break;
      case 'delivery_failed':
        if (state === 'running') {
          state = 'paused';
          pausedMs = t;
        }
        break;
      case 'credit_granted': {
        const c = creditOf(e);
        if ((state === 'running' || state === 'paused') && c !== null) {
          credit = Math.min(credit + c, MAX_CREDIT_MS);
        }
        break;
      }
      case 'window_ended':
        if (state === 'running') state = 'ended';
        break;
      default:
        if (RESUME_KINDS.has(e.kind) && state === 'paused' && pausedMs !== null) {
          credit = Math.min(credit + ceilToHour(t - pausedMs), MAX_CREDIT_MS);
          state = 'running';
          pausedMs = null;
        }
    }
  }
  if (state === 'running' && now.getTime() >= endsMs()) state = 'ended';

  return {
    state,
    started_at: startedMs === null ? null : iso(startedMs),
    base_ends_at: baseEndMs === null ? null : iso(baseEndMs),
    ends_at: baseEndMs === null ? null : iso(endsMs()),
    paused_at: state === 'paused' && pausedMs !== null ? iso(pausedMs) : null,
    credit_ms: credit,
  };
}

/** Access follows money and window: available only while money is captured and the window runs or is paused. */
export function deriveAccessState(money: MoneyState, window: WindowState): AccessState {
  if (money === 'refunded' || money === 'reversed' || window.state === 'revoked') return 'revoked';
  if (money !== 'captured') return 'locked';
  switch (window.state) {
    case 'running':
    case 'paused':
      return 'available';
    case 'ended':
      return 'ended';
    default:
      return 'locked';
  }
}
