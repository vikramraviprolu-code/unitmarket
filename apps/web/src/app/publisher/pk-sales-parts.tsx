import type { ReactNode } from 'react';
import type { EnvironmentLabel } from '@umsbx/contracts';
import { Chip } from '../../ui/publisher/kit';
import { envText } from '../../ui/EnvLabel';
import { envTone } from '../../lib/publisher-sales-view';

// PUB-UI-SALES: small pieces shared by the sales page and the statement page.

/** The environment as a chip. The word comes from the stored environment, never from a typed string. */
export function EnvChip({ environment }: { environment: EnvironmentLabel }) {
  return (
    <Chip tone={envTone(environment)}>
      {envText(environment)}
      <span className="visually-hidden">
        {environment === 'sandbox'
          ? ': test payments only, no real money'
          : ': no PayPal contact, no real money'}
      </span>
    </Chip>
  );
}

/** A collapsed block for the long explanatory notes. */
export function Details({
  summary,
  children,
  testId,
}: {
  summary: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <details className="pk-details" data-testid={testId}>
      <summary>{summary}</summary>
      <div className="pk-details-body">{children}</div>
    </details>
  );
}

/** A table that may be wider than the screen: a labelled region the keyboard can scroll. */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={label}>
      {children}
    </div>
  );
}
