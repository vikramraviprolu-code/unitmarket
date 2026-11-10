// LEGAL-A (docs/specs/legal-a-pages.md): the words of the four draft legal pages, the footer link
// labels and the sign-in privacy sentence, as plain data. Rendered by ui/LegalPage.tsx and pinned by
// golden/legal-copy.golden.txt. Drafted for the owners to approve; not legal advice. No dash
// characters and no italics (owner style rule). Dates are fixed strings, never computed.

import { CONTACT_ADDRESS } from './account-copy';
import { DEFAULT_ACCESS_DAYS } from './format';

export const LEGAL_BANNER = 'Draft for owner approval. This is not legal advice.';
export const LEGAL_SANDBOX_LINE =
  "This is a test build. No real money moves. Payments use PayPal's sandbox with test money, or, in a dry run, nothing contacts PayPal at all.";

export interface LegalSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

export interface LegalDoc {
  readonly slug: 'terms' | 'privacy' | 'refunds' | 'publisher-terms';
  readonly href: string;
  readonly title: string;
  readonly updated: string;
  readonly banner: string;
  readonly sandbox: string;
  readonly sections: readonly LegalSection[];
}

const UPDATED = 'Drafted 30 October 2026';

// AGREE-1: the version of the publisher terms the seeded acceptance record names. One source: bump it when
// the publisher terms change and every record that names an older version shows as changed, not re-accepted.
export const PUBLISHER_TERMS_VERSION = 'v1';

export const TERMS_DOC: LegalDoc = {
  slug: 'terms',
  href: '/legal/terms',
  title: 'Terms of purchase',
  updated: UPDATED,
  banner: LEGAL_BANNER,
  sandbox: LEGAL_SANDBOX_LINE,
  sections: [
    {
      heading: 'About these terms',
      paragraphs: [
        "These terms say what you agree to when you buy a unit on UnitMarket. They are the final terms for this sandbox demo. They are not legal advice. No real money moves: payments use PayPal's sandbox or a dry run.",
      ],
    },
    {
      heading: 'What a unit is',
      paragraphs: [
        "A unit is one article, or one part of a publisher's content, that you buy on its own instead of paying for a whole subscription. Before you pay, the offer shows what the unit is, what it costs and what access it gives.",
      ],
    },
    {
      heading: 'Personal use only',
      paragraphs: [
        'A unit is for your personal use only. You may not copy it for others, resell it, post it in public or share your access with another person. Redistribution of any kind is not allowed. Publishers keep their rights in their content.',
      ],
    },
    {
      heading: 'How long you have access',
      paragraphs: [
        `Access lasts ${DEFAULT_ACCESS_DAYS} days from verified payment and ready delivery. The ${DEFAULT_ACCESS_DAYS} days start once your payment is verified and the content is ready to deliver, whichever happens later. If we detect a delivery failure on our side, the lost time is credited back once delivery works again.`,
        'Access to a unit ends early if a full refund is made for that unit. The refund policy explains how refunds work.',
      ],
    },
    {
      heading: 'Price and terms are held for 15 minutes',
      paragraphs: [
        'Once you start to buy, the price and the terms you were shown are held for 15 minutes. Nothing is charged until you approve the payment at PayPal. If you leave without paying, your unpaid order stays open until you cancel it or it expires, and you can continue to payment or cancel it from the order page. When the held price has gone, ask for a price again; the price or terms may be different the next time.',
      ],
    },
    {
      heading: 'How you pay',
      paragraphs: [
        'You pay through PayPal. There is one PayPal payment for each publisher. If your order has content from two publishers, it is paid in two separate PayPal payments, one for each publisher.',
      ],
    },
    {
      heading: 'Test money only',
      paragraphs: [
        "This is a test build. No real money moves. Payments use PayPal's sandbox with test money, or, in a dry run, nothing contacts PayPal at all. Nothing you buy here has real value.",
      ],
    },
  ],
};

export const PRIVACY_DOC: LegalDoc = {
  slug: 'privacy',
  href: '/legal/privacy',
  title: 'Privacy notice',
  updated: UPDATED,
  banner: LEGAL_BANNER,
  sandbox: LEGAL_SANDBOX_LINE,
  sections: [
    {
      heading: 'About this notice',
      paragraphs: [
        "This notice says what data this demo processes and why. It is the final notice for this sandbox demo. It is not legal advice. No real money moves: payments use PayPal's sandbox or a dry run.",
      ],
    },
    {
      heading: 'What we process',
      paragraphs: [
        'A session cookie, which keeps you signed in as the test persona you chose.',
        'An appearance cookie named um_skin. It holds only the name of the skin you chose, and nothing about you. It is set only when you choose a skin, and it lasts 180 days.',
        'A hashed network address. We do not keep your network address itself. We keep a hash of it, so we can limit how fast requests arrive and keep the demo safe.',
        'The persona you chose, your orders, and your access events, such as when access to a unit started and when it ended.',
        'What you type to describe what you need, and the quotes and approvals made from it. If the AI helper is switched on, that text is sent to an AI model provider. It never receives payment data.',
        'PayPal processes your payment details on its own pages. We never see card data. Payer email addresses and names are redacted from our logs.',
      ],
    },
    {
      heading: 'Why we process it',
      paragraphs: [
        'We use this data only to run the demo. That means signing you in, keeping a record of what you bought and for how long, showing your library, limiting abuse, and looking into a problem with an order.',
      ],
    },
    {
      heading: 'How long we keep it',
      paragraphs: [
        'The design keeps logs for 30 days at the host and records of calls to the payment provider for 90 days. Deletion after these periods is not automated yet. Orders, the ledger and database backups are kept for the judging period. Some records, such as receipts, may need to be kept as financial records.',
      ],
    },
    {
      heading: 'Export or deletion',
      paragraphs: [
        'You can ask for a copy of your data, or ask for it to be deleted, through the operator. An operator runs a script on request; it is not a button in the app. The copy is a file of your own rows, such as your name, your briefs, your orders and your receipts. Deletion replaces your name and sign-in subject with a pseudonym, removes the text of your briefs and ends your sessions. Orders, receipts, the ledger, help cases and the audit log are kept as records and are not changed. That includes the text you wrote in a help case request, because the history of a help case cannot be edited.',
      ],
    },
    {
      heading: 'Applications to publish',
      paragraphs: [
        'Anyone can apply to publish on the Apply to publish page without signing in. We store the publisher name, the country, the note you write and a hashed network address that limits how many applications arrive. We do not keep your network address itself.',
        'The note is kept as a permanent audit record, so it cannot be changed or deleted, and the privacy export and deletion script does not cover it. Please do not put a phone number, a personal address, a password or payment details in it. An email address in the note is stored only in hashed form.',
        'No account is created by an application. The operator reviews it, and signing in for a publisher is set up separately by the owners.',
      ],
    },
    {
      heading: 'Buyer accounts',
      paragraphs: [
        `A buyer can make an account. We store the username, the display name and the country you give, and a hash of your password. We never store the password itself, and we do not ask for or keep an email address. Making an account also records that you accepted the Terms and this notice. When the operator deletes your data on request, your account and your sign in are removed, and the username can be used again. If you lose your password there is no reset link: the operator sets a new one on request, at ${CONTACT_ADDRESS}.`,
      ],
    },
    {
      heading: 'What we do not do',
      paragraphs: [
        'There is no advertising, no tracking scripts and no third-party fonts on this site. This site does not load scripts, fonts or images from other sites.',
      ],
    },
    {
      heading: 'Contact',
      paragraphs: ['You can reach the team at unitmarket@raviprolu.com.'],
    },
  ],
};

export const REFUNDS_DOC: LegalDoc = {
  slug: 'refunds',
  href: '/legal/refunds',
  title: 'Refund policy',
  updated: UPDATED,
  banner: LEGAL_BANNER,
  sandbox: LEGAL_SANDBOX_LINE,
  sections: [
    {
      heading: 'About this policy',
      paragraphs: [
        "This policy says how refunds work in this demo. It is the final policy for this sandbox demo. It is not legal advice. No real money moves: payments use PayPal's sandbox or a dry run.",
      ],
    },
    {
      heading: 'Who decides',
      paragraphs: [
        'Refunds are decided by an operator, for each unit. Nothing is refunded automatically, and there is no button for buyers to refund themselves. There is no refund request form yet. If an item did not open, choose "Problem with this item?" on its page in your library. An operator reads help cases about an order and decides whether a refund is right.',
      ],
    },
    {
      heading: 'A full refund',
      paragraphs: [
        "A full refund of one publisher's part of your order ends access to what you bought from that publisher. Links to it stop working. A copy you already downloaded cannot be recalled.",
      ],
    },
    {
      heading: 'A partial refund',
      paragraphs: [
        "A partial refund does not end access to that publisher's part of your order, unless partial refunds together reach the full amount paid for it. It is treated as a price adjustment for the order.",
      ],
    },
    {
      heading: 'When a refund takes effect',
      paragraphs: [
        'After an operator decides a refund, it is requested from PayPal. It is booked when PayPal confirms it. Until then your access does not change.',
      ],
    },
    {
      heading: 'Test money only',
      paragraphs: [
        'This is a test build. A refund returns test money to a test account, or, in a dry run, nothing is sent to PayPal. No real money moves.',
      ],
    },
  ],
};

export const PUBLISHER_TERMS_DOC: LegalDoc = {
  slug: 'publisher-terms',
  href: '/legal/publisher-terms',
  title: 'Publisher terms and sandbox disclaimer',
  updated: UPDATED,
  banner: LEGAL_BANNER,
  sandbox: LEGAL_SANDBOX_LINE,
  sections: [
    {
      heading: 'About these terms',
      paragraphs: [
        "These terms say what publishers can expect in this demo. They are the final terms for this sandbox demo. They are not legal advice. No real money moves: payments use PayPal's sandbox or a dry run. They describe only what the demo does today.",
      ],
    },
    {
      heading: 'Publishers here are fictional',
      paragraphs: [
        'Every publisher in this demo is fictional. Their names, articles and prices are made up for the demo and have no connection to any real publisher.',
      ],
    },
    {
      heading: 'Not exclusive',
      paragraphs: [
        'These terms are not exclusive. A publisher may sell the same articles anywhere else. In this demo either side may stop at any time at no charge. The only fee is the platform fee described under Commission.',
      ],
    },
    {
      heading: 'Your rights and our licence',
      paragraphs: [
        'When a publisher makes an offer for an article, it confirms that it owns the article or may license it. The publisher confirms this again with a rights checkbox on every revision of an offer, and UnitMarket stores that confirmation with the revision.',
        'The publisher gives UnitMarket a licence to sell access to single articles. The licence is not exclusive and it covers this demo.',
      ],
    },
    {
      heading: 'What buyers get',
      paragraphs: [
        `A buyer gets personal use access to the article for the window shown on the offer, which is ${DEFAULT_ACCESS_DAYS} days from verified payment and ready delivery. A buyer may not copy it for others, resell it or share the access. A copy a buyer has already downloaded cannot be recalled.`,
      ],
    },
    {
      heading: 'Takedown and corrections',
      paragraphs: [
        "A publisher can withdraw an article at any time. Withdrawing stops new sales at once. If an operator decides that buyers must be repaid, for example after a takedown request, the operator refunds buyers in full, one unit at a time, and a full refund ends that buyer's access.",
        'Once an offer is authorised, the content of the article does not change. A correction is published as a new article with a new offer. Buyers who already paid keep the version they bought for their window.',
      ],
    },
    {
      heading: 'Refunds',
      paragraphs: [
        'Refunds are decided by an operator, for each unit. A publisher cannot contest a refund in this demo. A refund is booked when PayPal confirms it. PayPal keeps the fee it charged on the original payment, so that fee is not returned when a payment is refunded.',
      ],
    },
    {
      heading: 'Disputes',
      paragraphs: [
        'This demo does not use the PayPal disputes service. It shows only the reversals that PayPal has confirmed. If a payment is disputed, the evidence is the stored delivery record for the unit, which shows when access was ready and when the links were used.',
      ],
    },
    {
      heading: 'Leaving',
      paragraphs: [
        "In this demo, leaving means a suspension by an operator. A suspended publisher's offers are hidden and no new approvals are accepted. A payment a buyer has already approved can still complete within its 15 minutes. The publisher keeps a final statement on its statement page.",
        'Buyers keep the access they paid for until their window ends. There is no balance to settle, because UnitMarket uses no payout mechanism.',
      ],
    },
    {
      heading: 'How a payee is checked',
      paragraphs: [
        "In this demo the publishers' payee details are marked as checked when the demo data is loaded or by an operator check. It is not PayPal onboarding. In the sandbox, payments for the publishers that have articles on sale are received in one test account the owners control, so their account endings match. A publisher with nothing on sale may have no payee account set. In a dry run nothing is paid, and the account endings are demo values.",
      ],
    },
    {
      heading: 'Commission',
      paragraphs: [
        'A platform fee of 10 percent of the publisher price is added to the price shown. The publisher does not pay it.',
      ],
    },
    {
      heading: 'Tax',
      paragraphs: [
        'No tax is calculated and no tax invoice is issued in this demo. Prices are the amounts the publisher sets. A receipt is a record of the sale, not a tax invoice.',
      ],
    },
    {
      heading: 'Where the money goes',
      paragraphs: [
        'UnitMarket uses no payout mechanism. It does not call any PayPal payout service.',
        'Each publisher has a statement page. It adds up the stored records of each payment: sales, refunds and reversals. The PayPal fee is shown beside them when PayPal reported it, and is not subtracted.',
      ],
    },
    {
      heading: 'Contact',
      paragraphs: ['You can reach the team at unitmarket@raviprolu.com.'],
    },
    {
      heading: 'Governing law',
      paragraphs: [
        'No governing law or court is named in this demo, because no company has been set up yet.',
      ],
    },
    {
      heading: 'Sandbox disclaimer',
      paragraphs: [
        "This is a test build. No real money moves. Payments use PayPal's sandbox with test money, or, in a dry run, nothing contacts PayPal at all. Nothing here is a live payment, a real sale or an offer to sell anything of real value.",
        'Publishers keep their rights in their content. Buyers get personal use only, as the terms of purchase say.',
      ],
    },
  ],
};

export const LEGAL_DOCS: readonly LegalDoc[] = [
  TERMS_DOC,
  PRIVACY_DOC,
  REFUNDS_DOC,
  PUBLISHER_TERMS_DOC,
];

// Footer link labels, keyed by slug (the hrefs are written out in app/layout.tsx).
export const LEGAL_NAV: Readonly<Record<LegalDoc['slug'], string>> = {
  terms: 'Terms of purchase',
  privacy: 'Privacy notice',
  refunds: 'Refund policy',
  'publisher-terms': 'Publisher terms',
};

// Sign-in page (PRIV-6). The last three words are the link to /legal/privacy.
export const SIGNIN_PRIVACY_LEAD =
  'We use a session cookie, an appearance cookie that holds only your skin name, and a hashed network address. Read ';
export const SIGNIN_PRIVACY_LINK = 'the privacy notice';
export const SIGNIN_PRIVACY_END = '.';
export const SIGNIN_PRIVACY_SENTENCE = `${SIGNIN_PRIVACY_LEAD}${SIGNIN_PRIVACY_LINK}${SIGNIN_PRIVACY_END}`;
