const { chromium } = require('playwright');
const { CURSOR_JS, startCapture, click, type, moveTo, smoothScroll } = require('./lib');
const OUT = process.argv[2] || __dirname + '/out';
const BASE = 'http://localhost:3200';
(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch();
  const ctx = await b.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1.5,
    baseURL: BASE,
  });
  await ctx.addInitScript(CURSOR_JS);
  const page = await ctx.newPage();
  // sign in off camera with the repo's public e2e fixture passcode
  await page.goto('/signin');
  await page.getByLabel('Who are you testing as?').selectOption(process.env.BUYER || 'buyer-a');
  await page.getByLabel('Demo passcode').fill('e2e passcode one');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'My library' }).waitFor();
  await page.goto('/');
  await page.waitForTimeout(800);
  await page.mouse.move(640, 300);
  const cap = await startCapture(page, OUT + '/frames-sbx');
  await page.waitForTimeout(1200);
  const need = page.getByLabel('What do you need?').first();
  await type(page, need, 'harbour charges and the quayside market, under $5');
  await page.waitForTimeout(400);
  await click(page, page.getByRole('button', { name: 'Find articles' }).first());
  await page.getByTestId('fit-card').first().waitFor();
  await page.waitForTimeout(1500);
  await click(page, page.getByLabel(/I accept the terms of purchase/));
  await click(page, page.getByRole('checkbox', { name: /small harbour charges/i }));
  await click(page, page.getByRole('checkbox', { name: /quayside market moved indoors/i }));
  await page.waitForTimeout(500);
  await click(page, page.getByRole('button', { name: 'Buy selected together' }));
  await page.waitForURL(/\/approve\//);
  await page.waitForTimeout(1200);
  const blocks = page.getByTestId('approve-block');
  await moveTo(page, blocks.nth(0));
  await page.waitForTimeout(1200);
  await moveTo(page, blocks.nth(1));
  await page.waitForTimeout(1200);
  await moveTo(page, page.getByTestId('pack-notice'));
  await page.waitForTimeout(1500);
  await click(page, page.getByLabel(/I confirm the price and terms above/));
  await click(page, page.getByRole('button', { name: 'Continue to payment' }));
  await page.waitForURL(/\/checkout\/dry-run\//);
  await page.waitForTimeout(1200);
  const approveNext = async () => {
    const form = page
      .locator('[data-testid^="dryrun-step-"]')
      .filter({ has: page.getByRole('button', { name: /^Approve payment \d of 2 \(dry run\)$/ }) })
      .first();
    await moveTo(page, form.getByRole('combobox'));
    await page.waitForTimeout(500);
    await form.getByRole('combobox').selectOption('happy');
    await click(page, form.getByRole('button', { name: /^Approve payment \d of 2 \(dry run\)$/ }));
  };
  await approveNext();
  await page.getByTestId('step-heading').waitFor();
  await page.waitForTimeout(2000);
  await click(page, page.getByRole('link', { name: /Approve payment 2 of 2 at PayPal/ }));
  await page.waitForURL(/\/checkout\/dry-run\//);
  await page.waitForTimeout(1000);
  await approveNext();
  await page.waitForURL(/\/orders\//);
  await page.waitForTimeout(2500);
  const rec = page.getByRole('link', { name: /View receipt/i }).first();
  if (await rec.count()) {
    await click(page, rec);
    await page.waitForTimeout(3000);
  }
  await click(page, page.getByRole('link', { name: 'My library' }).first());
  await page.waitForTimeout(3000);
  const r = await cap.stop(OUT + '/R-sbx-journey.mp4');
  console.log(JSON.stringify(r));
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
