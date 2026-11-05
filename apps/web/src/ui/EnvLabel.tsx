import type { EnvironmentLabel } from '@umsbx/contracts';

// The label comes from data (the app's environment or a stored row), never from a build flag (P16).
export function envText(environment: EnvironmentLabel): 'Dry run' | 'Sandbox' {
  return environment === 'sandbox' ? 'Sandbox' : 'Dry run';
}

/**
 * The environment pill. INT-UI0 extends it with an optional `className`, so the shell can place it without a
 * second copy of the component; the words and the test id stay the same.
 */
export function EnvLabel({
  environment,
  className,
}: {
  environment: EnvironmentLabel;
  className?: string;
}) {
  const text = envText(environment);
  return (
    <span
      className={`env env-${environment}${className ? ` ${className}` : ''}`}
      data-testid="env-label"
    >
      {text}
      <span className="visually-hidden">
        {environment === 'sandbox'
          ? ': test payments only, no real money'
          : ': no PayPal contact, no real money'}
      </span>
    </span>
  );
}
