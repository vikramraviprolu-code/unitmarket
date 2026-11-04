// API-B test support (not a test file). Boots the offline app, issues agent and buyer keys, opens mandates,
// calls the MCP route and the mandate routes the way a client does, and makes extra cheap offers so a
// scripted agent can buy many different units (a buyer can hold each article once). Synthetic values only.
import { issueKey } from '@umsbx/security';
import type { Actor, MandateView } from '@umsbx/contracts';
import { apiKeyDeps, createApiV1 } from '../../../../../composition.server';
import type { App } from '../../../../../composition.server';

export const ORIGIN = 'http://localhost:3000';
export type Handler = (
  req: Request,
  call?: { params?: Record<string, string> },
) => Promise<Response>;

let n = 0;
export const idem = (p = 'idem'): string => `${p}-${String(++n).padStart(6, '0')}-abcdef`;

export interface Caps {
  currency?: string;
  max_total_minor?: number | null;
  max_count?: number | null;
  max_per_purchase_minor?: number | null;
  expires_in_days?: number;
}

/** An agent key for a buyer, with a mandate unless `mandate: null`. Returns the bearer token. */
export async function newAgent(
  app: App,
  buyer: Actor,
  o: { scopes?: string[]; mandate?: Caps | null } = {},
): Promise<{ key_id: string; token: string; mandate: MandateView | null }> {
  const issued = await issueKey(apiKeyDeps(app), {
    owner: buyer,
    key_kind: 'agent',
    scopes: o.scopes ?? ['catalogue:read', 'library:read', 'agent:buy'],
  });
  if (!issued.ok) throw new Error(`issue refused: ${issued.error}`);
  let mandate: MandateView | null = null;
  if (o.mandate !== null) {
    if (buyer.kind !== 'buyer') throw new Error('buyer expected');
    const caps = o.mandate ?? { max_count: 5 };
    const m = await createApiV1(app).mandates.create({
      buyer_id: buyer.buyer_id,
      agent_key_id: issued.value.id,
      currency: caps.currency ?? 'USD',
      max_total_minor: caps.max_total_minor ?? null,
      max_count: caps.max_count ?? null,
      max_per_purchase_minor: caps.max_per_purchase_minor ?? null,
      expires_at: new Date(
        app.security.clock.now().getTime() + (caps.expires_in_days ?? 30) * 86_400_000,
      ).toISOString(),
    });
    if (!m.ok) throw new Error(`mandate refused: ${m.error}`);
    mandate = m.value;
  }
  return { key_id: issued.value.id, token: issued.value.token, mandate };
}

/** A buyer API client key (not an agent key) with the given scopes. */
export async function newClientKey(
  app: App,
  owner: Actor,
  scopes: string[] = ['catalogue:read', 'mandates:write'],
): Promise<{ key_id: string; token: string }> {
  const issued = await issueKey(apiKeyDeps(app), { owner, key_kind: 'api_client', scopes });
  if (!issued.ok) throw new Error(`issue refused: ${issued.error}`);
  return { key_id: issued.value.id, token: issued.value.token };
}

export async function setAgentBuy(app: App, on: boolean): Promise<void> {
  await app.db.query(
    `UPDATE safety_switches SET "on" = $1, changed_by = 'test', changed_at = $2, reason = 'test', updated_at = $2
      WHERE name = 'agent_buy_enabled'`,
    [on, app.security.clock.now().toISOString()],
  );
}

export interface Rpc {
  status: number;
  /** the parsed body (a JSON-RPC response, or the error envelope of a refused request) */
  body: {
    jsonrpc?: string;
    id?: unknown;
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: unknown };
  } & { error_envelope?: unknown; [k: string]: unknown };
  headers: Headers;
}

export function mcpRequest(
  token: string | null,
  payload: unknown,
  over: { idem?: string | null; headers?: Record<string, string>; raw?: string } = {},
): Request {
  return new Request(`${ORIGIN}/api/v1/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(over.idem === null ? {} : { 'idempotency-key': over.idem ?? idem('mcp') }),
      ...(over.headers ?? {}),
    },
    body: over.raw ?? JSON.stringify(payload),
  });
}

export async function mcpHandler(): Promise<Handler> {
  return (await import('./route')).POST as Handler;
}

export async function rpc(
  token: string | null,
  method: string,
  params?: unknown,
  over: { id?: unknown; idem?: string | null; headers?: Record<string, string> } = {},
): Promise<Rpc> {
  const post = await mcpHandler();
  const res = await post(
    mcpRequest(
      token,
      { jsonrpc: '2.0', id: over.id ?? 1, method, ...(params === undefined ? {} : { params }) },
      over,
    ),
  );
  const text = await res.text();
  return {
    status: res.status,
    body: text === '' ? {} : (JSON.parse(text) as Rpc['body']),
    headers: res.headers,
  };
}

export interface ToolOut {
  status: number;
  isError: boolean;
  /** the structured result of the tool: always has a `status` string */
  out: Record<string, unknown> & { status: string };
  text: string;
  rpc: Rpc;
}

export async function tool(
  token: string | null,
  name: string,
  args: unknown = {},
): Promise<ToolOut> {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  const result = (r.body.result ?? {}) as {
    structuredContent?: Record<string, unknown> & { status: string };
    isError?: boolean;
    content?: { type: string; text: string }[];
  };
  return {
    status: r.status,
    isError: result.isError === true,
    out:
      result.structuredContent ??
      ({ status: 'no_result' } as Record<string, unknown> & { status: string }),
    text: result.content?.map((c) => c.text).join('\n') ?? '',
    rpc: r,
  };
}

export const buyArgs = (
  publisher: string,
  offer: string,
  key = idem('buy'),
  more: object = {},
) => ({
  publisher,
  offer,
  idempotency_key: key,
  ...more,
});

/**
 * Makes `count` extra offers for one publisher, each its own article, with every option at `price_minor`.
 * Copies the rows of an existing offer. Returns the offer codes, `${prefix}-001` and so on.
 */
export async function extraOffers(
  app: App,
  o: {
    publisher: string;
    from: string;
    count: number;
    price_minor: number;
    prefix?: string;
    ai_scope?: string;
  },
): Promise<string[]> {
  const prefix = o.prefix ?? 'unit';
  const src = await app.db.query<Record<string, unknown>>(`SELECT * FROM offers WHERE id = $1`, [
    `ofr_${o.publisher}_${o.from}`,
  ]);
  const offer = src.rows[0];
  if (offer === undefined) throw new Error(`no offer ${o.publisher}/${o.from}`);
  const art = (
    await app.db.query<Record<string, unknown>>(`SELECT * FROM articles WHERE id = $1`, [
      offer['article_id'],
    ])
  ).rows[0]!;
  const codes: string[] = [];
  for (let i = 1; i <= o.count; i += 1) {
    const code = `${prefix}-${String(i).padStart(3, '0')}`;
    codes.push(code);
    const art_id = `art_${o.publisher}_${code}`;
    await app.db.query(
      `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
      [
        art_id,
        art['publisher_id'],
        `Unit ${code}`,
        `A short unit, ${code}.`,
        art['language'],
        art['topics'],
        art['published_at'],
        art['sha256'],
        `ck-${art_id}`,
        art['bytes'],
        art['mime'],
        art['created_at'],
      ],
    );
    // The bytes the unit delivers: a copy of the source article's blob under the new content key.
    await app.db.query(
      `INSERT INTO content_blobs (content_key, sha256, mime, bytes, data, created_at, updated_at)
       SELECT $2, sha256, mime, bytes, data, created_at, updated_at FROM content_blobs WHERE content_key = $1`,
      [art['content_key'], `ck-${art_id}`],
    );
    const options = (
      typeof offer['options'] === 'string' ? JSON.parse(offer['options']) : offer['options']
    ) as { option: string; price_minor: number }[];
    const rights = (
      typeof offer['rights'] === 'string' ? JSON.parse(offer['rights']) : offer['rights']
    ) as Record<string, unknown>;
    await app.db.query(
      `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, valid_until, superseded_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11, NULL, NULL, $12, $12)`,
      [
        `ofr_${o.publisher}_${code}`,
        offer['version'],
        offer['publisher_id'],
        art_id,
        offer['status'],
        offer['currency'],
        JSON.stringify(options.map((x) => ({ ...x, price_minor: o.price_minor }))),
        typeof offer['affordability'] === 'string'
          ? offer['affordability']
          : JSON.stringify(offer['affordability']),
        offer['terms_version'],
        JSON.stringify({ ...rights, ai_scope: o.ai_scope ?? 'agent_allowed' }),
        offer['valid_from'],
        offer['created_at'],
      ],
    );
    // A sellable offer version carries the publisher's authorisation (the quote checks for it).
    await app.db.query(
      `INSERT INTO publisher_authorisations (id, offer_id, offer_version, authorised_by, at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, $5)`,
      [
        `auth_ofr_${o.publisher}_${code}`,
        `ofr_${o.publisher}_${code}`,
        offer['version'],
        offer['publisher_id'],
        offer['created_at'],
      ],
    );
  }
  return codes;
}

export const setAiScope = (app: App, publisher: string, offer: string, ai_scope: string) =>
  app.db.query(
    `UPDATE offers SET rights = jsonb_set(rights, '{ai_scope}', to_jsonb($2::text)) WHERE id = $1`,
    [`ofr_${publisher}_${offer}`, ai_scope],
  );

export const rows = async (app: App, sql: string, p: unknown[] = []): Promise<number> =>
  Number((await app.db.query<{ c: string | number }>(sql, p)).rows[0]?.c ?? 0);

/**
 * A sandbox-mode app on a throwaway disk database: the stored environment is `sandbox`, so buy_unit must
 * hand the buyer a UnitMarket page and call nothing. No test Wire is injected, so the production Wire is the
 * only way out; the offline guard of the suite records any attempt. Synthetic values only.
 */
export async function bootSandboxApp(): Promise<{ app: App; dir: string }> {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { bootPackApp: boot } = await import('../../../../composite-support');
  const dir = mkdtempSync(join(tmpdir(), 'api-b-sbx-'));
  const app = await boot({
    UMS_MODE: 'sandbox',
    UMS_OUTBOUND_APPROVAL_REF: 'DL-2026-11-04-apib',
    PAYPAL_CLIENT_ID: 'synthetic-client-id-for-tests',
    PAYPAL_CLIENT_SECRET: 'synthetic-client-secret-for-tests-xyz',
    UMS_OWN_MERCHANT_ID: 'SBXOWNERTEST1',
    UMS_DB: 'pglite-disk',
    UMS_PGLITE_DIR: join(dir, 'db'),
  });
  // The sandbox payee step leaves publishers unverified (D-062); the order check needs a verified payee.
  await app.db.query(
    `UPDATE publishers SET payee_verified_at = $1 WHERE paypal_merchant_id IS NOT NULL AND payee_verified_at IS NULL`,
    [app.security.clock.now().toISOString()],
  );
  return { app, dir };
}
