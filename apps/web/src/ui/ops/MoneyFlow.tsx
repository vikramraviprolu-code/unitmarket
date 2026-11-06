import Link from 'next/link';
import type { MoneyFlowView } from '../../lib/money-flow-view';
import { MONEY_FLOW_HEADING } from '../../lib/money-flow-view';

// INT-OPS-C / OPS-C.5: the money-flow strip of operator Home. Each stage says its count in words; the stuck counts
// link to the operations behind them on the Problems page.
export function MoneyFlow({ view }: { view: MoneyFlowView }) {
  return (
    <div className="pk-panel" data-testid="money-flow">
      <ol className="pk-tiles oh-tiles" aria-label={MONEY_FLOW_HEADING}>
        {view.stages.map((s) => (
          <li key={s.key} data-testid={`money-flow-${s.key}`}>
            <p className="pk-tile-label">{s.label}</p>
            <p className="pk-tile-value">{s.count}</p>
          </li>
        ))}
      </ol>
      <p data-testid="money-flow-stuck">
        {view.stuckAny ? 'Stuck now: ' : 'Nothing is stuck. '}
        {view.stuck.sent} sent past their lease (
        <Link href="/ops/money/problems?op=sent">see them</Link>), {view.stuck.unknown} unknown past
        their reconcile time (<Link href="/ops/money/problems?op=unknown">see them</Link>).
      </p>
    </div>
  );
}
