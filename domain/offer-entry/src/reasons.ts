// The no-match reasons and the one way to build a no-match. A no-match carries a kind and a reason
// and nothing else: no alternative offer, no counter-price (architecture 9.12, A-05, A-07).
import type { NoMatch, NoMatchReason } from '@umsbx/contracts';

export const noMatch = (reason: NoMatchReason): NoMatch => ({ kind: 'no_match', reason });
