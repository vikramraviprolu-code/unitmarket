import type { CapCardView } from '../../lib/buyer-agents-view';
import './buyer.css';

// INT-BUY / BUY.1: the spend meter of one cap. The words come first and the bar second (never colour alone): the
// native <meter> carries the same numbers as the text beside it. No inline style, so the CSP holds.
export function SpendMeter({ card, label }: { card: CapCardView; label: string }) {
  return (
    <div className="spend-meter" data-testid="spend-meter" role="group" aria-label={label}>
      {card.money !== null ? (
        <>
          <p>
            Spent {card.money.spent_text} of {card.money.cap_text}. Left {card.money.left_text}.
          </p>
          <meter min={0} max={100} value={card.money.percent} aria-label={`${label}: money used`}>
            {card.money.percent} percent
          </meter>
        </>
      ) : null}
      {card.count !== null ? (
        <>
          <p>
            Bought {card.count.used} of {card.count.cap} purchases. Left {card.count.left}.
          </p>
          <meter
            min={0}
            max={100}
            value={card.count.percent}
            aria-label={`${label}: purchases used`}
          >
            {card.count.percent} percent
          </meter>
        </>
      ) : null}
    </div>
  );
}
