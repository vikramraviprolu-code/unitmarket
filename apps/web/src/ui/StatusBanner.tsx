import type { ReactNode } from 'react';

export type Tone = 'info' | 'success' | 'warn' | 'error';

// Status changes are announced (A11Y-4): role=status is polite, role=alert is assertive.
export function StatusBanner({
  tone = 'info',
  title,
  children,
  live = true,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  live?: boolean;
}) {
  const role = !live ? undefined : tone === 'error' ? 'alert' : 'status';
  return (
    <div className={`banner banner-${tone}`} role={role} data-testid="status-banner">
      {title ? <strong className="banner-title">{title}</strong> : null}
      {children ? <div>{children}</div> : null}
    </div>
  );
}
