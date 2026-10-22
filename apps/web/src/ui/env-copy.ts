import type { EnvironmentLabel } from '@umsbx/contracts';

// Footer and page description follow the app's stored environment label (P16), so they never
// disagree with the badge in the header.
export function siteFooter(environment: EnvironmentLabel): string {
  return environment === 'sandbox'
    ? 'Sandbox build for testing. Test payments only: no real money moves and nothing here is a live payment.'
    : 'Dry run for testing. Nothing contacts PayPal, no real money moves and nothing here is a live payment.';
}

export function siteDescription(environment: EnvironmentLabel): string {
  return environment === 'sandbox'
    ? 'Buy just the article you need. Sandbox build: test payments only, no real money moves.'
    : 'Buy just the article you need. Dry run: no PayPal contact, no real money moves.';
}
