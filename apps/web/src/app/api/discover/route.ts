import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../server/access';
import { buyerDisplay, currentRateSource, refreshRatesOnce } from '../../../server/buyer-display';
import { ceilingLine } from '../../../lib/buyer-price';

export const routeMeta: RouteMeta = {
  path: '/api/discover',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'discovery', per: 'actor', limit: 20, window_ms: 3_600_000 },
  // AI-H: one address cannot use up the allowance of the shared buyer personas (needs UMS_TRUSTED_PROXIES).
  rate_ip: { name: 'discovery-ip', per: 'ip', limit: 40, window_ms: 3_600_000 },
  max_body_bytes: 4096,
  idempotent: false,
  risk: 'medium',
};

const Input = z.object({ need: z.string().min(1).max(2000) }).strict();

// One body type for every 200 answer: a proposal (with display lines on converted items) or no match.
const reply = (body: object) => ({ status: 200 as const, body });

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const a = await app();
  // MC2-L5: one bounded refresh for the request. The ceiling compare inside discover and the display below
  // both read the stored rate; neither refreshes again.
  await refreshRatesOnce(a.engine);
  const d = await a.engine.discover({ actor, text: input.need });
  if (d.ai_off)
    return {
      status: 503,
      code: 'ai_off',
      message: 'Finding articles for a need is paused. You can still open an article link.',
    };
  const r = d.result;
  if ('parse_error' in r)
    return r.parse_error === 'too_long'
      ? { status: 422, code: 'too_long', message: 'Please shorten your need to 2000 characters.' }
      : {
          status: 422,
          code: 'unparseable',
          message: 'We could not read that need. Try fewer words.',
        };
  if (!r.ok) return { status: 404, code: 'not_found', message: 'That need was not found.' };
  if (r.value.kind !== 'proposal') return reply(r.value);
  // The quotes stay the seller's. Each item that is shown in another currency gets its display lines.
  const display = await buyerDisplay(a.engine, actor, {
    currencies: r.value.items.map((it) => it.quote.price.currency),
    refresh: false,
  });
  // A ceiling compared on a converted price is shown with both amounts; a sample rate is said to be one.
  const source = r.value.items.some((it) => it.ceiling_check !== undefined)
    ? await currentRateSource(a.engine)
    : null;
  const items = r.value.items.map((it) => {
    const view = display.view(it.quote.price);
    const shown = view.binding === null ? it : { ...it, display: view };
    return it.ceiling_check === undefined
      ? shown
      : {
          ...shown,
          ceiling_line: ceilingLine(it.ceiling_check.ceiling, it.ceiling_check.price, source),
        };
  });
  return reply({ ...r.value, items });
})(securityDeps);
