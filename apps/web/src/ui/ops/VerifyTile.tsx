import Link from 'next/link';
import type { VerifyTile as Tile } from '../../lib/verify-view';
import { Chip } from '../publisher/kit';
import './ops-b.css';

// INT-OPS-B / OPS-B.5: the trace verify tile. It paints what lib/verify-view.ts returns. "Run verify" is a
// plain link to ?verify=1: the server page runs the check only when that parameter is there (N-B1), so nothing
// runs on a normal page render and there is no route or server action behind the button.
export function VerifyTile({ tile }: { tile: Tile }) {
  const tone = tile.kind === 'ok' ? 'good' : tile.kind === 'broken' ? 'bad' : 'neutral';
  return (
    <div className="pk-panel" data-testid="verify-tile">
      <p role="status" data-testid="verify-result" data-kind={tile.kind}>
        <Chip tone={tone}>{tile.headline}</Chip>
        {tile.counts !== null ? <span> {tile.counts}</span> : null}
      </p>
      {tile.firstProblem !== null ? (
        <p data-testid="verify-first">First problem: {tile.firstProblem}</p>
      ) : null}
      {tile.lines.length > 0 ? (
        <ul className="vt-lines" aria-label="Verify findings">
          {tile.lines.map((l, i) => (
            <li key={`${String(i)}:${l}`}>{l}</li>
          ))}
        </ul>
      ) : null}
      {tile.more !== null ? <p>{tile.more}</p> : null}
      <div className="vt-actions">
        <Link href={tile.runHref} className="btn btn-primary">
          Run verify
        </Link>
        <Link href={tile.invariantsHref}>Platform invariants</Link>
      </div>
    </div>
  );
}
