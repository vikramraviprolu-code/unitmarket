// LEGAL-A (docs/specs/legal-a-pages.md): the words of the four draft legal pages, the footer link
// labels and the sign-in privacy sentence, as plain data. Rendered by ui/LegalPage.tsx and pinned by
// golden/legal-copy.golden.txt. Drafted for the owners to approve; not legal advice. No dash
// characters and no italics (owner style rule). Dates are fixed strings, never computed.

export const LEGAL_BANNER = 'Draft for owner approval. This is not legal advice.';
export const LEGAL_SANDBOX_LINE =
  'This is a sandbox demo. No real money moves, and every payment is test money.';

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
        'These terms say what you agree to when you buy a unit on UnitMarket. They are a draft written for the owners of this demo to read and approve. They are not legal advice, and they may change before the demo is submitted.',
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
        'Access lasts five days from verified payment and ready delivery. The five days start once your payment is verified and the content is ready to deliver, whichever happens later. If delivery fails on our side, your days are paused and then restored, so you do not lose time.',
        'Access to a unit ends early if a full refund is made for that unit. The refund policy explains how refunds work.',
      ],
    },
    {
      heading: 'Price and terms are held for 15 minutes',
      paragraphs: [
        'Once you start to buy, the price and the terms you were shown are held for 15 minutes. If you do not approve within that time, nothing is charged for that attempt. You can start again, and the price or terms may be different the next time.',
      ],
    },
    {
      heading: 'How you pay',
      paragraphs: [
        "You pay through PayPal, on PayPal's own pages. There is one PayPal payment for each publisher. If your order has content from two publishers, it is paid in two separate PayPal payments, one for each publisher.",
      ],
    },
    {
      heading: 'Test money only',
      paragraphs: [
        'This is a sandbox demo. Every payment uses test money from a test account. No real money moves, and nothing you buy here has real value.',
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
        'This notice says what data this demo processes and why. It is a draft written for the owners to read and approve. It is not legal advice, and it may change before the demo is submitted.',
      ],
    },
    {
      heading: 'What we process',
      paragraphs: [
        'A session cookie, which keeps you signed in as the test persona you chose.',
        'A hashed network address. We do not keep your network address itself. We keep a hash of it, so we can limit how fast requests arrive and keep the demo safe.',
        'The persona you chose, your orders, and your access events, such as when access to a unit started and when it ended.',
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
        'Logs are kept for 30 days at the host. Records of calls to the payment provider are kept for 90 days. Orders and the ledger are kept for the judging period. Some records, such as receipts, may need to be kept as financial records.',
      ],
    },
    {
      heading: 'Export or deletion',
      paragraphs: [
        'You can ask for a copy of your data, or ask for it to be deleted, through the operator. An operator carries out the request by hand.',
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
      paragraphs: ['Contact details will be added by the owners before submission.'],
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
        'This policy says how refunds work in this demo. It is a draft written for the owners to read and approve. It is not legal advice, and it may change before the demo is submitted.',
      ],
    },
    {
      heading: 'Who decides',
      paragraphs: [
        'Refunds are decided by an operator, for each unit. Nothing is refunded automatically, and there is no button for buyers to refund themselves. To ask for a refund, contact the operator.',
      ],
    },
    {
      heading: 'A full refund ends access',
      paragraphs: [
        'A full refund ends access to that unit. Links to it stop working. A copy you already downloaded cannot be recalled.',
      ],
    },
    {
      heading: 'A partial refund does not end access',
      paragraphs: [
        'A partial refund does not end access. It is treated as a price adjustment for the order, and access to every item in the order continues.',
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
        'This is a sandbox demo. A refund returns test money to a test account. No real money moves.',
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
        'These terms say what publishers can expect in this demo. They are a draft written for the owners to read and approve. They are not legal advice, and they may change before the demo is submitted.',
      ],
    },
    {
      heading: 'Publishers here are fictional',
      paragraphs: [
        'Every publisher in this demo is fictional. Their names, articles and prices are made up for the demo and have no connection to any real publisher.',
      ],
    },
    {
      heading: 'How a payee is checked',
      paragraphs: [
        'Before a publisher is treated as ready to be paid, an operator checks the payee details by hand. This is a check by an operator. It is not PayPal onboarding, and PayPal does not check the publisher in this demo.',
      ],
    },
    {
      heading: 'Commission',
      paragraphs: [
        'There is no commission in this demo. A commission of 20 percent is planned. It is not implemented.',
      ],
    },
    {
      heading: 'Where the money goes',
      paragraphs: [
        'UnitMarket uses no payout mechanism. It does not call any PayPal payout service.',
        "A publisher's statement shows where that publisher's money goes. It is read from the stored records of each payment, not typed in by hand.",
        'In this demo, payments for fictional publishers are received in a test account that the owners control.',
      ],
    },
    {
      heading: 'Sandbox disclaimer',
      paragraphs: [
        "This is a sandbox demo. Every payment uses PayPal's sandbox and test money. Nothing here is a live payment, a real sale or an offer to sell anything of real value. No real money moves.",
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
  'We use a session cookie and a hashed network address to keep this demo safe. Read ';
export const SIGNIN_PRIVACY_LINK = 'the privacy notice';
export const SIGNIN_PRIVACY_END = '.';
export const SIGNIN_PRIVACY_SENTENCE = `${SIGNIN_PRIVACY_LEAD}${SIGNIN_PRIVACY_LINK}${SIGNIN_PRIVACY_END}`;
