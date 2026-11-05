import Link from 'next/link';
import { currentActor } from '../../server/session';
import { readBellCounts } from '../../composition/ops-home';
import { bellLabel } from '../../lib/ops-alerts-view';

// INT-OPS-A / OPS-A.2: the alert bell of the operator shell. It shows how many alerts still wait and links to
// /ops/alerts. It reads and writes nothing else. A visitor who is not an operator sees no bell, so the count of
// open alerts is never shown before sign in.
export async function AlertBell() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') return null;
  const c = await readBellCounts();
  return (
    <Link
      href="/ops/alerts"
      className="shell-bell"
      aria-label={bellLabel(c)}
      data-testid="alert-bell"
      data-count={c.total}
    >
      <span aria-hidden="true">Alerts</span>
      <span className="shell-bell-count" aria-hidden="true">
        {c.total}
      </span>
    </Link>
  );
}
