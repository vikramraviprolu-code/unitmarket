import Link from 'next/link';
import { SETUP_HEADING, SETUP_LABEL, stateWord } from '../../lib/seller-home-view';
import type { SetupStep } from '../../lib/seller-home-view';

// INT-SEL / SEL.4: the steps to a first sale. Each step says its state in words, not by colour alone.
export function SetupPath({ steps }: { steps: readonly SetupStep[] }) {
  return (
    <section aria-labelledby="setup-h" className="pk-section" data-testid="seller-setup">
      <h2 id="setup-h">{SETUP_HEADING}</h2>
      <ol aria-label={SETUP_LABEL} className="pk-steps">
        {steps.map((s) => (
          <li key={s.id} data-testid={`setup-${s.id}`} data-state={s.state}>
            <strong>{stateWord(s.state)}.</strong>{' '}
            {s.href !== null && s.state !== 'done' ? <Link href={s.href}>{s.label}</Link> : s.label}
          </li>
        ))}
      </ol>
    </section>
  );
}
