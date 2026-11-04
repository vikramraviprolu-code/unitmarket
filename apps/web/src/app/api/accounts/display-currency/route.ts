import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';
import { DISPLAY_CURRENCY_FAILED } from '../../../../lib/buyer-price';

// MC2-L5 (D-084 item 4): the signed-in buyer chooses the currency prices are shown in as an estimate, or
// "auto" to derive it from the country again. It is the session's own row: the body names no buyer and a
// field that tries to is refused (strict). It changes what is displayed and nothing that is bought or stored.
export const routeMeta: RouteMeta = {
  path: '/api/accounts/display-currency',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'account-display-currency', per: 'actor', limit: 20, window_ms: 900_000 },
  max_body_bytes: 256,
  idempotent: false,
  risk: 'low',
};

const Input = z.object({ currency: z.enum(['USD', 'EUR', 'GBP', 'auto']) }).strict();

export const POST = withRoute(routeMeta, Input, async ({ input, actor }) => {
  const currency = input.currency === 'auto' ? null : input.currency;
  const saved = await (await app()).engine.displayCurrency.set({ actor, currency });
  if (!saved) return { status: 403, code: 'forbidden', message: DISPLAY_CURRENCY_FAILED };
  return { status: 200, body: { currency: input.currency } };
})(securityDeps);
