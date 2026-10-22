import type { ReactNode } from 'react';

// Errors say what happened and what to do next (A11Y-7). No stack, no internal detail.
export function ErrorState({
  title = 'Something went wrong',
  children,
  action,
}: {
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="banner banner-error" role="alert" data-testid="error-state">
      <strong className="banner-title">{title}</strong>
      {children ? <div>{children}</div> : null}
      {action ? <div className="actions">{action}</div> : null}
    </div>
  );
}
