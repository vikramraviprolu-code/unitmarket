/* eslint-disable no-restricted-imports -- TEMP-until-lane-16: the test stack (@umsbx/testkit testDb, testDeps) is not on main yet; swap this helper for it then. */
// Test helper only (never exported from index.ts): migrated in-memory PGlite, a seeded catalogue that
// adds climate articles for discovery, and deps for the agent path. Pattern adapted from
// domain/offer-entry/src/support.ts (lane 14a). Content is synthetic and fictional.
import { migrate, openDatabase } from '@umsbx/db';
import { fakeClock, seededIds } from '@umsbx/runtime';
import { SEED_DATA, seedCatalogue } from '@umsbx/catalogue';
import { createScriptedModel } from '@umsbx/model';
import type { AgentDeps, Database, ModelPort, ModelRequest, ModelResponse } from '@umsbx/contracts';

export const T0 = '2026-10-21T10:00:00.000Z';
export type TestDb = Database & { close(): Promise<void> };

const RIGHTS = { scope: 'personal_use', ai_scope: 'review', redistribution: false } as const;
const FIXED = { renegotiation_allowed: false, floor_minor: null } as const;
const both = (keep: number, online: number) => [
  { option: 'keep_retrieve', price_minor: keep },
  { option: 'online_read', price_minor: online },
];
const article = (
  key: string,
  title: string,
  abstract: string,
  topics: string[],
  published_at: string,
  language = 'en',
) => ({
  key,
  publisher_slug: 'harbour-ledger',
  title,
  abstract,
  language,
  topics,
  published_at,
  text: 'Synthetic sandbox body written by the SBX team.\n',
  rights_note: 'Written by the SBX team for the sandbox.',
});
const offer = (
  code: string,
  options: { option: string; price_minor: number }[],
  status = 'authorised',
  authorised = true,
) => ({
  code,
  article_key: code,
  status,
  currency: 'USD',
  options,
  affordability: FIXED,
  authorised,
  terms_version: 'terms-1',
  rights: RIGHTS,
  valid_from: '2026-01-01T00:00:00.000Z',
  valid_until: null,
  superseded_by: null,
});

// Climate set: prices in USD minor units. Online-read prices at or under 600: c1 150, c2 300, c3 450,
// c4 500, c5 550, c6 600, c7 580. Over 600: c8 650, c9 900. c10 is withdrawn, c11 is a draft, c12 is
// German, c13 sells only the keep option.
const CLIMATE = [
  article(
    'c1',
    'Climate adaptation for cities: a primer',
    'Plans for hot cities.',
    ['climate'],
    '2026-10-10T09:00:00.000Z',
  ),
  article(
    'c2',
    'Adaptation budgets in small cities',
    'Climate money, city halls.',
    ['cities'],
    '2026-09-01T09:00:00.000Z',
  ),
  article(
    'c3',
    'Climate and the city street',
    'Shade, drains and trees.',
    ['adaptation'],
    '2026-02-01T09:00:00.000Z',
  ),
  article(
    'c4',
    'Cities after the flood',
    'Adaptation lessons.',
    ['climate', 'cities'],
    '2025-05-01T09:00:00.000Z',
  ),
  article(
    'c5',
    'A climate note for city planners',
    'Short note.',
    ['planning'],
    '2026-10-15T09:00:00.000Z',
  ),
  article(
    'c6',
    'Adaptation in practice',
    'Cities and heat.',
    ['climate'],
    '2026-08-15T09:00:00.000Z',
  ),
  article(
    'c7',
    'Cities, heat and adaptation',
    'Climate maps for every city block.',
    ['heat'],
    '2026-10-18T09:00:00.000Z',
  ),
  article(
    'c8',
    'Climate adaptation for cities: the long report',
    'Everything in full.',
    ['climate', 'cities', 'adaptation'],
    '2026-10-19T09:00:00.000Z',
  ),
  article(
    'c9',
    'Climate adaptation finance for cities',
    'Bonds and budgets.',
    ['climate', 'cities', 'adaptation'],
    '2026-10-20T09:00:00.000Z',
  ),
  article(
    'c10',
    'Withdrawn climate adaptation for cities',
    'Gone.',
    ['climate'],
    '2026-10-01T09:00:00.000Z',
  ),
  article(
    'c11',
    'Draft climate adaptation for cities',
    'Not authorised.',
    ['climate'],
    '2026-10-02T09:00:00.000Z',
  ),
  article(
    'c12',
    'Klimaanpassung fuer Staedte',
    'Climate adaptation cities auf Deutsch.',
    ['climate'],
    '2026-10-03T09:00:00.000Z',
    'de',
  ),
  article(
    'c13',
    'Climate adaptation for cities, print edition',
    'Keep only.',
    ['climate', 'cities'],
    '2026-10-04T09:00:00.000Z',
  ),
];
const CLIMATE_OFFERS = [
  offer('c1', both(150, 150)),
  offer('c2', both(300, 300)),
  offer('c3', both(450, 450)),
  offer('c4', both(500, 500)),
  offer('c5', both(550, 550)),
  offer('c6', both(600, 600)),
  offer('c7', both(580, 580)),
  offer('c8', both(650, 650)),
  offer('c9', both(900, 900)),
  offer('c10', both(200, 200), 'withdrawn'),
  offer('c11', both(200, 200), 'draft', false),
  offer('c12', both(200, 200)),
  offer('c13', [{ option: 'keep_retrieve', price_minor: 200 }]),
];

export const CLIMATE_BRIEF = 'climate adaptation for cities, under $6, read online, English';

export function extraData(
  articles: ReturnType<typeof article>[] = [],
  offers: ReturnType<typeof offer>[] = [],
) {
  return {
    ...SEED_DATA,
    articles: [...SEED_DATA.articles, ...CLIMATE, ...articles],
    offers: [...SEED_DATA.offers, ...CLIMATE_OFFERS, ...offers],
  };
}
export { article as seedArticle, offer as seedOffer, both as seedBoth };

export async function seededDb(
  data: ReturnType<typeof extraData> = extraData(),
): Promise<{ db: TestDb; deps: AgentDeps; recorder: Recorder }> {
  const db = await openDatabase({ kind: 'pglite-memory' });
  const clock = fakeClock(T0);
  await migrate(db, clock);
  const ids = seededIds('discovery');
  await seedCatalogue(db, clock, ids, data);
  const recorder = recordingModel(createScriptedModel());
  return { db, deps: depsWith(db, recorder.model), recorder };
}

let runs = 0;
export function depsWith(db: TestDb, model: ModelPort): AgentDeps {
  const clock = fakeClock(T0);
  // A distinct id stream per deps object, so two deps on one database never draw the same id.
  const ids = seededIds(`discovery-run-${++runs}`);
  // Discovery uses only db, clock, ids and model; the rest of AgentDeps is not touched.
  return { db, clock, ids, model } as unknown as AgentDeps;
}

export interface Recorder {
  model: ModelPort;
  requests: ModelRequest[];
}
export function recordingModel(inner: ModelPort): Recorder {
  const requests: ModelRequest[] = [];
  const model: ModelPort = {
    model_id: inner.model_id,
    async complete(r: ModelRequest): Promise<ModelResponse> {
      requests.push(structuredClone(r));
      return inner.complete(r);
    },
  };
  return { model, requests };
}

let n = 0;
export async function addBuyer(
  db: TestDb,
  over: { country?: string; display_name?: string; auth_subject?: string } = {},
): Promise<string> {
  const id = `buy_test_${++n}`;
  await db.query(
    'INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)',
    [
      id,
      over.display_name ?? `Buyer ${n}`,
      over.auth_subject ?? `sub-${n}`,
      over.country ?? 'US',
      T0,
    ],
  );
  return id;
}

export async function count(db: TestDb, table: string): Promise<number> {
  const { rows } = await db.query<{ c: string | number }>(`SELECT count(*) AS c FROM ${table}`);
  return Number(rows[0]!.c);
}
