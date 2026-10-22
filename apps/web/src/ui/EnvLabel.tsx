import type { EnvironmentLabel } from '@umsbx/contracts';

// The label comes from data (the app's environment or a stored row), never from a build flag (P16).
export function envText(environment: EnvironmentLabel): 'Dry run' | 'Sandbox' {
  return environment === 'sandbox' ? 'Sandbox' : 'Dry run';
}

export function EnvLabel({ environment }: { environment: EnvironmentLabel }) {
  const text = envText(environment);
  return (
    <span className={`env env-${environment}`} data-testid="env-label">
      {text}
      <span className="visually-hidden">
        {environment === 'sandbox'
          ? ': test payments only, no real money'
          : ': no PayPal contact, no real money'}
      </span>
    </span>
  );
}
