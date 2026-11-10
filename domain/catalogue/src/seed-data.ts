// SBX lane 14a seed data. Synthetic and fictional: two invented publishers and eight articles written
// by the team for this sandbox. No real publisher brand, no real paywalled text, no URLs.
// Prices are the publisher's (minor units). Mirrored in fixtures/catalogue/seed.json (a test keeps them equal).
import { WORLDWIDE_PAYEE_COUNTRIES } from '@umsbx/contracts';
const T0 = '2026-01-01T00:00:00.000Z';
const RIGHTS = { scope: 'personal_use', ai_scope: 'review', redistribution: false } as const;
const BOTH = (keep: number, online: number) => [
  { option: 'keep_retrieve', price_minor: keep },
  { option: 'online_read', price_minor: online },
];
const FIXED = { renegotiation_allowed: false, floor_minor: null } as const;

export const SEED_DATA = {
  meta: {
    source: 'synthetic',
    note: 'Fictional publishers and team-written articles for the SBX sandbox.',
  },
  corridors: [
    {
      id: 'gb-gbp',
      currency: 'GBP',
      minor_units: 2,
      buyer_countries: ['*'],
      payee_countries: [...WORLDWIDE_PAYEE_COUNTRIES],
      domestic_supported: true,
      min_charge_minor: null,
      enabled: true,
    },
  ],
  publishers: [
    { slug: 'harbour-ledger', display_name: 'Harbour Ledger Review (fictional)', country: 'US' },
    {
      slug: 'northfield-quarterly',
      display_name: 'Northfield Quarterly (fictional)',
      country: 'GB',
    },
  ],
  articles: [
    {
      key: 'tide-tables',
      publisher_slug: 'harbour-ledger',
      title: 'Reading a tide table in ten minutes',
      abstract:
        'A short guide to the columns of a coastal tide table and what they mean for a day on the water.',
      language: 'en',
      topics: ['sailing', 'navigation'],
      published_at: '2025-11-03T09:00:00.000Z',
      text: 'A tide table lists the time and height of each high and low water for one port.\n\nRead the day first, then the height. Subtract the height of low water from the next high water to get the range, and plan the crossing around the hour when the range is smallest.\n',
      rights_note:
        'Written by the SBX team for the sandbox. Personal use only; no redistribution; AI use on review.',
    },
    {
      key: 'ferry-timetables',
      publisher_slug: 'harbour-ledger',
      title: 'Why ferry timetables slip in winter',
      abstract:
        'Four small causes of winter delays on short coastal ferry routes, from tides to crew rotas.',
      language: 'en',
      topics: ['transport', 'maritime'],
      published_at: '2025-11-10T09:00:00.000Z',
      text: 'Winter timetables carry less slack. A ferry that turns around in twelve minutes in July needs twenty when the quay is wet.\n\nCrew rotas add a second effect: one late arrival moves every later sailing.\n',
      rights_note:
        'Written by the SBX team for the sandbox. Personal use only; no redistribution; AI use on review.',
    },
    {
      key: 'harbour-fees',
      publisher_slug: 'harbour-ledger',
      title: 'What a small harbour charges and why',
      abstract:
        'A plain-language walk through mooring, berthing and water fees at a small working harbour.',
      language: 'en',
      topics: ['harbours', 'costs'],
      published_at: '2025-11-17T09:00:00.000Z',
      text: 'Harbour fees fall into three groups: a charge for the space, a charge for services, and a charge for the time.\n\nThe space charge follows the length of the boat. Services such as water and power are metered. Time is usually per night, with a lower weekly rate.\n',
      rights_note:
        'Written by the SBX team for the sandbox. Personal use only; no redistribution; AI use on review.',
    },
    {
      key: 'knot-notebook',
      publisher_slug: 'harbour-ledger',
      title: 'A notebook of six working knots',
      abstract: 'Six knots a small-boat sailor uses weekly, with the one mistake that spoils each.',
      language: 'en',
      topics: ['sailing', 'skills'],
      published_at: '2025-11-24T09:00:00.000Z',
      text: 'The bowline, the clove hitch, the figure eight, the sheet bend, the round turn and two half hitches, and the rolling hitch.\n\nEach fails the same way: it is tied once, quickly, and never checked under load.\n',
      rights_note:
        'Written by the SBX team for the sandbox. Personal use only; no redistribution; AI use on review.',
    },
    {
      key: 'dock-history',
      publisher_slug: 'harbour-ledger',
      title: 'The dock that was never finished',
      abstract:
        'A short history of an invented dock scheme, and what its unfinished quay still tells the town.',
      language: 'en',
      topics: ['history', 'harbours'],
      published_at: '2025-12-01T09:00:00.000Z',
      text: 'The scheme was approved in a wet spring and abandoned by the autumn.\n\nWhat remains is a quay that stops in mid-air, used now by anglers and by the town on festival days.\n',
      rights_note:
        'Written by the SBX team for the sandbox. Personal use only; no redistribution; AI use on review.',
    },
    {
      key: 'draft-weather-notes',
      publisher_slug: 'harbour-ledger',
      title: 'Weather notes for the shoulder season (draft)',
      abstract: 'A draft set of notes on reading a falling barometer in spring and autumn.',
      language: 'en',
      topics: ['weather', 'sailing'],
      published_at: '2025-12-08T09:00:00.000Z',
      text: 'A barometer that falls three millibars in three hours is a warning, not a forecast.\n\nCombine it with the wind shift before deciding to leave the mooring.\n',
      rights_note:
        'Written by the SBX team for the sandbox. Personal use only; no redistribution; AI use on review.',
    },
    {
      key: 'allotment-diary',
      publisher_slug: 'northfield-quarterly',
      title: 'An allotment diary for a cold March',
      abstract:
        'Week-by-week notes from an invented allotment on what to sow under cover and what to leave alone.',
      language: 'en',
      topics: ['gardening', 'seasonal'],
      published_at: '2025-11-05T09:00:00.000Z',
      text: 'Week one: sow nothing outdoors. Start leeks and onions in trays on a window sill.\n\nWeek three: the soil is still below six degrees; leave the carrots.\n',
      rights_note:
        'Written by the SBX team for the sandbox. Personal use only; no redistribution; AI use on review.',
    },
    {
      key: 'village-bus',
      publisher_slug: 'northfield-quarterly',
      title: 'How a village bus route is saved',
      abstract: 'A case study of an invented rural bus route kept alive by a parish scheme.',
      language: 'en',
      topics: ['transport', 'community'],
      published_at: '2025-11-12T09:00:00.000Z',
      text: 'The route carried eleven passengers a day and cost more than it earned.\n\nThe parish bought the Tuesday and Friday runs, and the operator kept the rest.\n',
      rights_note:
        'Written by the SBX team for the sandbox. Personal use only; no redistribution; AI use on review.',
    },
  ],
  offers: [
    {
      code: 'tide-tables',
      article_key: 'tide-tables',
      status: 'authorised',
      currency: 'USD',
      options: BOTH(40, 40),
      affordability: FIXED,
      authorised: true,
    },
    {
      code: 'ferry-timetables',
      article_key: 'ferry-timetables',
      status: 'authorised',
      currency: 'USD',
      options: BOTH(125, 125),
      affordability: FIXED,
      authorised: true,
    },
    {
      code: 'harbour-fees',
      article_key: 'harbour-fees',
      status: 'authorised',
      currency: 'USD',
      options: BOTH(300, 250),
      affordability: { renegotiation_allowed: true, floor_minor: 200 },
      authorised: true,
    },
    {
      code: 'knot-notebook',
      article_key: 'knot-notebook',
      status: 'authorised',
      currency: 'USD',
      options: BOTH(450, 450),
      affordability: FIXED,
      authorised: true,
    },
    {
      code: 'dock-history',
      article_key: 'dock-history',
      status: 'withdrawn',
      currency: 'USD',
      options: BOTH(200, 200),
      affordability: FIXED,
      authorised: true,
    },
    {
      code: 'draft-weather-notes',
      article_key: 'draft-weather-notes',
      status: 'draft',
      currency: 'USD',
      options: BOTH(200, 200),
      affordability: FIXED,
      authorised: false,
    },
    {
      code: 'allotment-diary',
      article_key: 'allotment-diary',
      status: 'authorised',
      currency: 'GBP',
      options: BOTH(150, 150),
      affordability: FIXED,
      authorised: true,
    },
    {
      code: 'village-bus',
      article_key: 'village-bus',
      status: 'authorised',
      currency: 'GBP',
      options: BOTH(90, 90),
      affordability: FIXED,
      authorised: true,
    },
  ].map((o) => ({
    ...o,
    terms_version: 'terms-1',
    rights: RIGHTS,
    valid_from: T0,
    valid_until: null,
    superseded_by: null,
  })),
} as const;

// MVP-D supplementary block (DP-1, M4): one more fictional US publisher with two authorised USD
// offers, so a pack of two publishers in one currency exists. It is applied after the base seed by
// seedSupplement under its own Ids, so SEED_DATA and every id of the base seed stay as they are.
// Mirrored in fixtures/catalogue/seed-composite.json (a test keeps them equal).
export const SEED_SUPPLEMENT_COMPOSITE = {
  meta: {
    source: 'synthetic',
    note: 'Supplementary block for MVP-D: one fictional US publisher and two team-written articles. Applied after the base seed by seedSupplement.',
  },
  corridors: [],
  publishers: [
    { slug: 'quayside-gazette', display_name: 'Quayside Gazette (fictional)', country: 'US' },
  ],
  articles: [
    {
      key: 'market-hall-move',
      publisher_slug: 'quayside-gazette',
      title: 'Why the quayside market moved indoors',
      abstract:
        'A short account of an invented market that left the open quay for a covered hall, and what its traders say changed.',
      language: 'en',
      topics: ['markets', 'local'],
      published_at: '2025-12-15T09:00:00.000Z',
      text: 'The market stood on the quay for ninety years. A wet decade and a new drainage rule moved it into a covered hall in one winter.\n\nTraders report fewer lost days and fewer casual buyers. The hall is dry; the footfall is not.\n',
      rights_note:
        'Written by the SBX team for the sandbox. Personal use only; no redistribution; AI use on review.',
    },
    {
      key: 'quay-walk',
      publisher_slug: 'quayside-gazette',
      title: 'A morning walk along the old quay',
      abstract:
        'A short walking route past four invented landmarks, with what each was built to do.',
      language: 'en',
      topics: ['walking', 'history'],
      published_at: '2025-12-22T09:00:00.000Z',
      text: 'Start at the clock stand and walk east.\n\nThe crane base, the net store and the customs shed each served one trade. Only the shed is still roofed.\n',
      rights_note:
        'Written by the SBX team for the sandbox. Personal use only; no redistribution; AI use on review.',
    },
  ],
  offers: [
    {
      code: 'market-hall-move',
      article_key: 'market-hall-move',
      status: 'authorised',
      currency: 'USD',
      options: BOTH(150, 120),
      affordability: FIXED,
      authorised: true,
    },
    {
      code: 'quay-walk',
      article_key: 'quay-walk',
      status: 'authorised',
      currency: 'USD',
      options: BOTH(90, 90),
      affordability: FIXED,
      authorised: true,
    },
  ].map((o) => ({
    ...o,
    terms_version: 'terms-1',
    rights: RIGHTS,
    valid_from: T0,
    valid_until: null,
    superseded_by: null,
  })),
} as const;

// MC2-L2 (D-084 item 6): the German euro corridor and one fictional German publisher with three EUR offers.
// WW-COR: the corridor is in the worldwide shape, enabled, payee = every ISO country except IN, the same row
// migration 0034 writes (migrate() runs before the seed, so on every database the row already exists and
// this one is only the mirror; a test keeps them equal). Applied on every boot after the composite block by
// seedSupplement, so it reaches a database that already holds the older seed (the base seed runs only on an
// empty database). Corridors are inserted with ON CONFLICT DO NOTHING, so a switch an operator made is never
// undone and the seed can never narrow the migration's row. buyer_countries ['*'] is a documentation value:
// buyer country is data, not a gate (D-084 item 3). Names and texts are fictional and written by the SBX team;
// no real brand, no URL.
export const SEED_SUPPLEMENT_DE = {
  meta: {
    source: 'synthetic',
    note: 'MC2-L2: the disabled de-eur corridor, one fictional German publisher and three team-written German articles with EUR offers. Applied after the base seed by seedSupplement.',
  },
  corridors: [
    {
      id: 'de-eur',
      currency: 'EUR',
      minor_units: 2,
      buyer_countries: ['*'],
      payee_countries: [...WORLDWIDE_PAYEE_COUNTRIES],
      domestic_supported: true,
      min_charge_minor: null,
      enabled: true,
    },
  ],
  publishers: [
    { slug: 'rheinwerft-kurier', display_name: 'Rheinwerft Kurier (fictional)', country: 'DE' },
  ],
  articles: [
    {
      key: 'schleusenzeiten',
      publisher_slug: 'rheinwerft-kurier',
      title: 'Wie eine Schleuse den Tag eines Binnenschiffers taktet',
      abstract:
        'Ein kurzer Blick auf Wartezeiten, Schleusenkammern und Pausen auf einer erfundenen Flussstrecke.',
      language: 'de',
      topics: ['binnenschifffahrt', 'verkehr'],
      published_at: '2025-12-29T09:00:00.000Z',
      text: 'Eine Schleuse hebt ein Schiff in zwanzig Minuten um vier Meter. Die Wartezeit davor ist selten kürzer.\n\nWer die Kammerzeiten kennt, legt die Pause vor die Schleuse und nicht dahinter.\n',
      rights_note:
        'Written by the SBX team for the sandbox. Personal use only; no redistribution; AI use on review.',
    },
    {
      key: 'marktplatz-uhr',
      publisher_slug: 'rheinwerft-kurier',
      title: 'Die Uhr am Marktplatz, die nie richtig ging',
      abstract:
        'Eine erfundene Kleinstadt streitet seit Jahrzehnten über eine Turmuhr, die jeden Tag eine andere Zeit zeigt.',
      language: 'de',
      topics: ['lokales', 'geschichte'],
      published_at: '2026-01-05T09:00:00.000Z',
      text: 'Die Uhr geht vier Minuten vor, im Winter sieben. Der Stadtrat hat sie dreimal reparieren lassen.\n\nDie Marktleute stellen ihre Stände nach ihr auf. Wer pünktlich sein will, fragt zuerst den Bäcker.\n',
      rights_note:
        'Written by the SBX team for the sandbox. Personal use only; no redistribution; AI use on review.',
    },
    {
      key: 'fahrradfaehre',
      publisher_slug: 'rheinwerft-kurier',
      title: 'Eine Fahrradfähre im Winterfahrplan',
      abstract:
        'Warum eine kleine Fähre für Radfahrer im Winter seltener fährt und was die Stammgäste davon halten.',
      language: 'de',
      topics: ['verkehr', 'freizeit'],
      published_at: '2026-01-12T09:00:00.000Z',
      text: 'Im Sommer fährt die Fähre jede Viertelstunde, im Winter jede Stunde. Das Wasser ist niedrig und die Anleger sind glatt.\n\nDie Stammgäste kommen trotzdem. Sie planen den Heimweg nach dem Fahrplan an der Kaimauer.\n',
      rights_note:
        'Written by the SBX team for the sandbox. Personal use only; no redistribution; AI use on review.',
    },
  ],
  offers: [
    {
      code: 'schleusenzeiten',
      article_key: 'schleusenzeiten',
      status: 'authorised',
      currency: 'EUR',
      options: BOTH(150, 120),
      affordability: FIXED,
      authorised: true,
    },
    {
      code: 'marktplatz-uhr',
      article_key: 'marktplatz-uhr',
      status: 'authorised',
      currency: 'EUR',
      options: BOTH(100, 100),
      affordability: FIXED,
      authorised: true,
    },
    {
      code: 'fahrradfaehre',
      article_key: 'fahrradfaehre',
      status: 'authorised',
      currency: 'EUR',
      options: BOTH(200, 180),
      affordability: FIXED,
      authorised: true,
    },
  ].map((o) => ({
    ...o,
    terms_version: 'terms-1',
    rights: RIGHTS,
    valid_from: T0,
    valid_until: null,
    superseded_by: null,
  })),
} as const;
