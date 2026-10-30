// HARD-E2E (GATE35 D2, FIX-FLOW D4): a buyer who reaches the pay page and leaves without approving has an order that
// was never paid. The library says so in the library's own words ("Not paid yet"), not "Confirming payment" and not a
// payment pending at PayPal, offers no receipt and no way to open the item. Offline, dry run. Buyer A has not touched
// this article in any other spec.
import { test, expect } from '@playwright/test';
import { askPrice, buyerPage, toApproval, toDryRunCheckout } from './support';

const TITLE = 'A morning walk along the old quay';

test('an order left at the pay page shows Not paid yet, with no receipt and no way in', async ({
  browser,
}) => {
  const page = await buyerPage(browser, 'a');
  await askPrice(page, {
    offer: 'quay-walk',
    publisher: 'quayside-gazette',
    option: 'Read online',
  });
  await toApproval(page);
  await toDryRunCheckout(page);
  // The buyer leaves here: the pretend payment is never approved.
  await page.goto('/library');
  const item = page.getByTestId('library-item').filter({ hasText: TITLE });
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId('library-status')).toContainText('Not paid yet');
  await expect(item.getByTestId('library-status')).not.toContainText(
    /Confirming|pending at PayPal/i,
  );
  await expect(item.getByRole('button')).toHaveCount(0);

  await item.getByRole('link', { name: TITLE }).click();
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
  await expect(page.getByTestId('library-status')).toContainText(
    'Not paid yet. We have not received a payment for this order.',
  );
  await expect(page.getByText('Payment', { exact: true })).toBeVisible();
  await expect(page.locator('dd', { hasText: /^Not paid yet$/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View receipt' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Read here' })).toHaveCount(0);
  await expect(page.getByTestId('env-label').first()).toContainText('Dry run');
  await page.context().close();
});
