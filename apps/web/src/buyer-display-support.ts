// Test helper for MC2-L5 (not a test file). An offline app whose rate fetch is a fake that stores today's
// date (1 EUR = 1.2 USD = 0.8 GBP), the German and British corridors switched on, and buyers of any country
// with a session. Fictional ids; no PayPal, no socket.
import { createSession } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import { createApp, installApp } from '../composition.server';
import type { App } from '../composition.server';
import { testEnv } from './support';
import type { Session } from './support';

/** 1 EUR = 1.2 USD = 0.8 GBP, so 1 USD = 0.8333 EUR, 1 EUR = 0.8 GBP and 1 USD = 0.6667 GBP. */
export const RATES = { usd: '1.2000', gbp: '0.8000' } as const;

export interface DisplayWorld {
  app: App;
  /** Today in UTC, read from the database (no clock call in the test). */
  today: string;
  fetchCalls: () => number;
  buyer(country: string, chosen?: string | null): Promise<{ actor: Actor; session: Session }>;
  close(): Promise<void>;
}

let n = 0;
export async function bootDisplayWorld(
  fetch: 'rates' | 'offline' = 'rates',
): Promise<DisplayWorld> {
  let calls = 0;
  let today = '';
  const app = createApp(await testEnv(), {
    switch_cache_ms: 0,
    test_seed: { de_corridor: true },
    ...(fetch === 'rates'
      ? {
          test_fx_fetch: async () => {
            calls++;
            return { ok: true as const, date: today, usd: RATES.usd, gbp: RATES.gbp };
          },
        }
      : {}),
  });
  installApp(app);
  await app.ready();
  today = (
    await app.db.query<{ d: string }>("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d")
  ).rows[0]!.d;
  await app.db.query("UPDATE corridors SET enabled = true WHERE id IN ('gb-gbp', 'de-eur')");
  return {
    app,
    today,
    fetchCalls: () => calls,
    async buyer(country, chosen) {
      const id = `buy_disp_${String(++n)}`;
      await app.db.query(
        `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
         VALUES ($1, 'Display buyer', $2, $3, now(), now())`,
        [id, `test:disp-${String(n)}`, country],
      );
      if (chosen !== undefined && chosen !== null) {
        await app.db.query('UPDATE buyers SET display_currency = $2 WHERE id = $1', [id, chosen]);
      }
      const actor: Actor = { kind: 'buyer', buyer_id: id };
      const s = await createSession(app.security, actor);
      return { actor, session: { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token } };
    },
    close: () => app.close(),
  };
}

/** "2026-11-04" as the buyer sees it: "4 Nov 2026". Written out here so a test does not use the formatter it checks. */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${String(Number(d))} ${months[Number(m) - 1]!} ${y}`;
}
