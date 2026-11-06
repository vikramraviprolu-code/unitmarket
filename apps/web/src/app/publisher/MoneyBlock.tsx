import { StatTile } from '../../ui/publisher/kit';
import { moneyTiles } from '../../lib/payout-copy';
import type { MoneyFigures } from '../../lib/payout-copy';

// POB-M1 (D-089): the fee on top, what is owed, what was paid out, the open adjustments and the next payout of one block
// (currency and environment). Every figure comes from the statement read model, which sums stored rows; nothing is worked out
// here. Shown only for a block that has a split (an old block has none and shows nothing new).
export function MoneyBlock({
  money,
  currency,
  testId,
}: {
  money: MoneyFigures;
  currency: string;
  testId: string;
}) {
  return (
    <div className="pk-tiles pk-block-tiles" data-testid={testId}>
      {moneyTiles(money, currency).map((t) => (
        <StatTile
          key={t.key}
          label={t.label}
          value={t.value}
          {...(t.note === undefined ? {} : { note: t.note })}
          testId={`${testId}-${t.key}`}
        />
      ))}
    </div>
  );
}
