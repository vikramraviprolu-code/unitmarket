// The words of the web import (POB-I1, D-089): the domain proof, the start of an import, the progress, the
// review list and the publish step. Pure: no server module, no clock. Wording rules: D-051 (the verb follows
// the count), no italics, no dashes. The environment word (Sandbox or Dry run) is never typed here: the pages
// take it from the stored environment. Every refusal is a plain sentence that ends with a full stop.

// ---- the start page
export const IMPORT_HEADING = 'Add your catalogue from your website';
export const IMPORT_LEDE =
  'Give us the web address of your site. We read the items, pictures and prices you have published there, show them to you in a list, and you choose what to put on sale.';
export const IMPORT_SAFE_NOTE =
  'We only read pages on an address you have proved is yours. We read structured data (schema.org, OpenGraph, RSS, Atom, JSON feed, sitemap), not free text, and we do not follow links to other sites.';

export const DOMAIN_HEADING = 'Step 1. Prove the address is yours';
export const DOMAIN_LEDE =
  'Enter the address of your site. Put your code on that site, then ask us to check. The code is the same for every address you add.';
export const DOMAIN_HOST_LABEL = 'Your website (for example shop.example.com)';
export const DOMAIN_ADD_BUTTON = 'Get my code';
export const DOMAIN_CHECK_BUTTON = 'Check my site';
export const DOMAIN_TOKEN_HEADING = 'Your code';
export const DOMAIN_TOKEN_NOTE =
  'This is your permanent code. It is also shown at the top of this page, so you can read it again at any time.';
export const DOMAIN_HOW_HEADING = 'Two ways to show the code';
export const DOMAIN_HOW_META =
  'Add one meta tag to the head of your front page, with the name unitmarket-verify and your code as the content.';
export const DOMAIN_HOW_FILE =
  'Or serve a text file at /.well-known/unitmarket-verify.txt that holds only the code.';
export const DOMAIN_LIST_HEADING = 'Your addresses';
export const DOMAIN_EMPTY = 'No address yet.';
export const DOMAIN_VERIFIED = 'Proved';
export const DOMAIN_PENDING = 'Waiting for the code';
export const CODE_HEADING = 'Your code';
export const CODE_INSTRUCTION = 'Put this code once on each of your sites';
export const CODE_NOTE =
  'The code stays the same. If your address changes, put the same code on the new address, then ask us to check.';
export const DOMAIN_VERIFIED_BY_US = 'Verified by UnitMarket';
export const DOMAIN_REMOVE_BUTTON = 'Remove this address';
export const DOMAIN_REMOVED = 'The address was removed. Offers already on sale stay on sale.';
export const DOMAIN_CHECKED_OK = 'Your site passed the check.';

export const BEGIN_HEADING = 'Step 2. Read my items';
export const BEGIN_LEDE =
  'Choose the address of the page or feed to read. It must be on a site you have proved. We check the code again before we start.';
export const BEGIN_URL_LABEL = 'Address of the page or feed';
export const BEGIN_BUTTON = 'Start reading';
export const BEGIN_STARTED = 'The import has started. This page shows its progress.';

export const BATCHES_HEADING = 'Your imports';
export const BATCHES_EMPTY = 'No import yet.';
export const BATCH_OPEN = 'Open the list';

// ---- the review page
export const REVIEW_HEADING = 'Review what we found';
export const REVIEW_LEDE =
  'Nothing is on sale yet. Choose what to show, change a title or a price, then publish.';
export const COL_TITLE = 'Title';
export const COL_KIND = 'Kind';
export const COL_PRICE = 'Your price';
export const COL_BUYER_PRICE = 'Buyer pays';
export const COL_STATE = 'Status';
export const COL_SHOW = 'Show';
export const KIND_ARTICLE = 'Text';
export const KIND_IMAGE = 'Picture';
export const SAVE_BUTTON = 'Save';
export const HIDE_LABEL = 'Hide this item';
export const NO_PRICE = 'Set a price';
export const BUYER_PRICE_NOTE =
  'The buyer price is your price plus UnitMarket fee. The final fee is shown when the buyer pays.';
export const PRICE_HELP = 'Type the price like 2.50.';
export const ITEMS_EMPTY = 'No item in this list.';
export const PUBLISH_HEADING = 'Publish';
export const PUBLISH_LEDE =
  'Publishing puts the shown items with a price on sale. Each one gets a copy that UnitMarket hosts for the buyer.';
export const ATTEST_LABEL =
  'I confirm that I have the right to sell this content and that the prices are mine.';
export const PUBLISH_BUTTON = 'Publish the shown items';
export const PUBLISHED_DONE = 'Done.';
export const BACK_LINK = 'Back to imports';

export function batchStateText(state: string): string {
  switch (state) {
    case 'queued':
      return 'Waiting to start';
    case 'running':
      return 'Reading your site';
    case 'done':
      return 'Finished';
    case 'failed':
      return 'Stopped with a problem';
    case 'interrupted':
      return 'Stopped before the end';
    default:
      return 'Unknown';
  }
}

export function itemStateText(state: string): string {
  switch (state) {
    case 'staged':
      return 'Ready to publish';
    case 'hidden':
      return 'Hidden';
    case 'published':
      return 'On sale';
    case 'refused':
      return 'Not imported';
    default:
      return 'Unknown';
  }
}

/** The reason an item was not imported. */
export function itemReasonText(reason: string): string {
  switch (reason) {
    case 'no_text':
      return 'The item has no text we could read.';
    case 'no_image':
      return 'The item has no picture we could read.';
    case 'image_off_host':
      return 'The picture is on another site, and we only read your own.';
    case 'image_failed':
      return 'We could not read the picture.';
    case 'bad_image':
      return 'The picture is not a JPEG, PNG or WebP image.';
    case 'too_large':
      return 'The picture is larger than 2 MB.';
    case 'page_failed':
      return 'We could not read the page of the item.';
    case 'no_structured_data':
      return 'The page has no data we can read.';
    default:
      return 'The item was not imported.';
  }
}

/** The note on a batch that ended early or found nothing. */
export function batchNoteText(note: string): string {
  switch (note) {
    case 'deadline':
      return 'The import took too long and stopped. What was read is in the list.';
    case 'paused':
      return 'Imports were paused, so this one stopped. What was read is in the list.';
    case 'restart':
      return 'The service restarted during this import. What was read is in the list.';
    case 'check_failed':
      return 'The import stopped because a safety check could not be read.';
    case 'no_structured_data':
      return 'We found no items. The page has no data we can read.';
    case 'unsupported_type':
      return 'We found no items. That address is not a page or a feed we can read.';
    case 'bad_document':
      return 'We found no items. The page or feed is not well formed.';
    case 'sitemap_index':
      return 'That address is a list of sitemaps. Use the address of one sitemap.';
    case 'too_many_items':
      return 'The source holds more than 100 items. Point us to a smaller list.';
    case 'publisher_not_active':
      return 'Your publisher account is not active, so the import stopped.';
    case 'no_corridor':
      return 'We cannot set prices for your country yet, so the import stopped.';
    case 'private_address':
    case 'dns_failed':
    case 'timeout':
    case 'network':
    case 'pin_mismatch':
    case 'host_not_allowed':
      return 'We could not reach the address. Check that it is public and answers over https.';
    case 'redirect':
      return 'The address sends visitors elsewhere, and we do not follow that. Use the final address.';
    default:
      return 'The source could not be read.';
  }
}

/** D-051: the noun follows the total, the verb follows the number done. */
export function progressText(done: number, total: number, refused: number): string {
  const head = `${String(done)} of ${String(total)} ${total === 1 ? 'item' : 'items'} ${done === 1 ? 'is' : 'are'} done.`;
  if (refused <= 0) return head;
  return `${head} ${String(refused)} ${refused === 1 ? 'was' : 'were'} refused.`;
}

export function publishedText(n: number): string {
  return n === 1 ? '1 item is on sale.' : `${String(n)} items are on sale.`;
}

const ERRORS: Record<string, string> = {
  not_publisher: 'Sign in as a publisher to import a catalogue.',
  publisher_not_active: 'Your publisher account is not active, so imports are off.',
  invalid_input: 'Something in the request was not right. Check the fields and try again.',
  invalid_host: 'That is not a web address we can check. Use a name like shop.example.com.',
  invalid_address: 'Use a full web address that starts with https and has a name, not a number.',
  host_taken: 'Another publisher has already proved control of that address.',
  too_many_domains: 'You can add up to 10 web addresses.',
  domain_not_verified:
    'That address is not one you have proved yet. Prove it first, then start the import.',
  proof_missing:
    'We could not find your code on that address yet. Add the tag or the file, then check again.',
  proof_refused:
    'We could not reach that address. Check that it is public and answers over https, then try again.',
  proof_lost:
    'We could not find your code on that address any more, so nothing was imported. Check the tag or the file, then try again.',
  site_unreachable:
    'We could not reach your site at that address. Check that it is online.',
  not_operator: 'Only an operator can do that.',
  mfa_required: 'Enter your authenticator code to do that.',
  unchanged: 'That address is already verified.',
  import_off: 'Web import is switched off here.',
  paused: 'Imports are paused for now. Try again later.',
  import_active: 'You already have an import in progress. Wait for it to finish.',
  no_corridor: 'We cannot set prices for your country yet, so imports are not available.',
  not_found: 'We could not find that.',
  not_editable: 'That item can no longer be changed.',
  invalid_title: 'Give the item a title in plain words.',
  invalid_price: 'Enter a price like 2.50, above zero and within the limit.',
  attestation_required: 'Confirm that you have the right to sell this content before publishing.',
  batch_not_ready: 'This import is still running. Publish when it has finished.',
  fee_unavailable:
    'We cannot read the platform fee right now, so nothing was published. Try again in a few minutes.',
};

/** The sentence for an error code; a code we do not know gets the general one. */
export function importErrorText(code: string): string {
  return Object.hasOwn(ERRORS, code) ? ERRORS[code]! : ERRORS['invalid_input']!;
}

export type ImportStatus = 403 | 404 | 409 | 422 | 503;

/** The HTTP status of an error code. */
export function importStatusOf(code: string): ImportStatus {
  switch (code) {
    case 'not_publisher':
    case 'publisher_not_active':
    case 'domain_not_verified':
    case 'not_operator':
    case 'mfa_required':
      return 403;
    case 'not_found':
      return 404;
    case 'host_taken':
    case 'proof_lost':
    case 'site_unreachable':
    case 'import_active':
    case 'unchanged':
    case 'paused':
    case 'batch_not_ready':
    case 'not_editable':
      return 409;
    case 'import_off':
    case 'fee_unavailable':
      return 503;
    default:
      return 422;
  }
}
