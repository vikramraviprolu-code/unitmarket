// Repro for the refund.spec.ts:72 flake (main 16ad163). The server refuses a TOTP step it has already seen
// (a code is accepted only above the operator's highest used step). Every operator spec signs in with the
// code of the step after the server's (step + 1), so two operator sign-ins inside one 30 s window send the
// same code and the second is refused. quick-find.spec.ts signs in just before refund.spec.ts, which had no
// retry. This spec signs the operator in twice, back to back, through the shared helper and expects both to
// reach Operations. The file name sorts after operator-mfa.spec.ts and before every other operator spec, so
// the codes still rise in order.
import { test, expect } from '@playwright/test';
import { operatorWithCode } from './operator-session';

test('two operator sign-ins in one TOTP window both reach Operations', async ({ browser }) => {
  test.setTimeout(120_000);
  const first = await operatorWithCode(browser);
  const second = await operatorWithCode(browser);
  await expect(first.page.getByRole('heading', { level: 1, name: /Operations/ })).toBeVisible();
  await expect(second.page.getByRole('heading', { level: 1, name: /Operations/ })).toBeVisible();
  await first.ctx.close();
  await second.ctx.close();
});
