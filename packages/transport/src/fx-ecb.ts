import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';

// MC2-L4 (D-085). The one egress to the European Central Bank's daily euro reference rates. It is not
// a payment API and needs no approval row, but it is a new outbound host, so it is as small as the model
// wire: one host, one path, GET only, no credentials and no body. It shares nothing with the sandbox
// Wire, the approval minter or the PayPal endpoints, and it cannot reach them.
//
// Fixed limits: no redirect is followed (a 3xx is an error and its Location is never requested), the
// answer is at most 64 KB, the whole exchange 3 s. The file is read by a strict hand parser, not an XML
// library: only the known envelope and `<Cube currency='XXX' rate='n'/>` entries are accepted, rates
// of currencies other than USD and GBP are ignored, a DOCTYPE, entity, comment or processing
// instruction is refused. Errors carry a fixed kind and no text from the peer.
//
// Whether a new rate may replace the stored one (a move over 10%, an older date) is the domain's call
// (domain/fx), which holds the stored rates; this file only fetches and validates the shape.

/** The one host. Not configurable. */
export const ECB_API = 'https://www.ecb.europa.eu';
export const ECB_PATH = '/stats/eurofxref/eurofxref-daily.xml';
export const ECB_MAX_RESPONSE_BYTES = 64 * 1024;
export const ECB_DEADLINE_MS = 3000;

const ECB_URL = `${ECB_API}${ECB_PATH}`;
const HOST = new URL(ECB_API).hostname;

export type EcbErrorKind =
  | 'refused'
  | 'redirect'
  | 'status'
  | 'too_large'
  | 'timeout'
  | 'network'
  | 'bad_shape'
  | 'missing_currency'
  | 'bad_rate'
  | 'bad_date';

/** A failed fetch or parse. Only the kind is kept: no url, no header, no text from the peer. */
export class EcbError extends Error {
  readonly kind: EcbErrorKind;
  constructor(kind: EcbErrorKind) {
    super(`ecb fx: ${kind}`);
    this.name = 'EcbError';
    this.kind = kind;
  }
}

/** The ECB date and the two rates as the decimal strings the file carries (1 EUR = rate quote). */
export interface EcbRates {
  date: string;
  usd: string;
  gbp: string;
}
export type EcbFetchResult = ({ ok: true } & EcbRates) | { ok: false; kind: EcbErrorKind };

// ---- parser ---------------------------------------------------------------------------------------

const RATE = /^\d{1,5}(?:\.\d{1,6})?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ENTRY = /<Cube currency='([A-Z]{3})' rate='([^']*)'\/>/y;
const MAX_ENTRIES = 200;

function checkDate(s: string): string {
  const m = DATE.exec(s);
  if (m === null) throw new EcbError('bad_date');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1999 || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d)
    throw new EcbError('bad_date');
  return s;
}

function checkRate(s: string): string {
  if (!RATE.test(s)) throw new EcbError('bad_rate');
  const n = Number(s);
  if (!Number.isFinite(n) || !(n > 0)) throw new EcbError('bad_rate');
  return s;
}

/** Reads the ECB daily file. Throws EcbError (and nothing else) for anything that is not the known shape. */
export function parseEcbDaily(xml: string): EcbRates {
  if (typeof xml !== 'string') throw new EcbError('bad_shape');
  if (Buffer.byteLength(xml, 'utf8') > ECB_MAX_RESPONSE_BYTES) throw new EcbError('too_large');
  let i = 0;
  const ws = (): void => {
    while (i < xml.length && ' \t\r\n'.includes(xml.charAt(i))) i++;
  };
  const lit = (s: string): void => {
    if (!xml.startsWith(s, i)) throw new EcbError('bad_shape');
    i += s.length;
  };
  lit('<?xml version="1.0" encoding="UTF-8"?>');
  ws();
  lit(
    '<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">',
  );
  ws();
  lit('<gesmes:subject>Reference rates</gesmes:subject>');
  ws();
  lit('<gesmes:Sender>');
  ws();
  lit('<gesmes:name>European Central Bank</gesmes:name>');
  ws();
  lit('</gesmes:Sender>');
  ws();
  lit('<Cube>');
  ws();
  lit("<Cube time='");
  const q = xml.indexOf("'", i);
  if (q < 0) throw new EcbError('bad_shape');
  const date = checkDate(xml.slice(i, q));
  i = q + 1;
  lit('>');
  let usd: string | undefined;
  let gbp: string | undefined;
  for (let n = 0; ; n++) {
    ws();
    if (xml.startsWith('</Cube>', i)) break;
    if (n >= MAX_ENTRIES) throw new EcbError('bad_shape');
    ENTRY.lastIndex = i;
    const m = ENTRY.exec(xml);
    if (m === null) throw new EcbError('bad_shape');
    i = ENTRY.lastIndex;
    const cur = m[1];
    if (cur === 'USD') {
      if (usd !== undefined) throw new EcbError('bad_shape');
      usd = checkRate(m[2] ?? '');
    } else if (cur === 'GBP') {
      if (gbp !== undefined) throw new EcbError('bad_shape');
      gbp = checkRate(m[2] ?? '');
    }
  }
  lit('</Cube>');
  ws();
  lit('</Cube>');
  ws();
  lit('</gesmes:Envelope>');
  ws();
  if (i !== xml.length) throw new EcbError('bad_shape');
  if (usd === undefined || gbp === undefined) throw new EcbError('missing_currency');
  return { date, usd, gbp };
}

// ---- fetch ----------------------------------------------------------------------------------------

export interface EcbFetchDeps {
  /** The request function (https.request captured at load; a fake in tests). */
  request: typeof https.request;
  agent: https.Agent;
}

export interface EcbExchange {
  method: string;
  url: string;
}

/** Internal: builds the fetch from its dependencies. Used by createEcbFetch and by its tests. */
export function makeEcbFetch(deps: EcbFetchDeps): {
  exchange(r: EcbExchange): Promise<{ status: number; body: string }>;
  fetchRates(): Promise<EcbRates>;
} {
  function exchange(r: EcbExchange): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const fail = (kind: EcbErrorKind): void => reject(new EcbError(kind));
      // Everything that can be wrong with the request is checked before a socket exists.
      if (r === null || typeof r !== 'object') return fail('refused');
      if (r.method !== 'GET' || r.url !== ECB_URL) return fail('refused');

      let finished = false;
      let req: ClientRequest | undefined;
      let res: IncomingMessage | undefined;
      const settle = (done: () => void): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          res?.destroy();
        } catch {
          /* already gone */
        }
        try {
          req?.destroy();
        } catch {
          /* already gone */
        }
        done();
      };
      const settleFail = (kind: EcbErrorKind): void => settle(() => fail(kind));

      const timer = setTimeout(() => settleFail('timeout'), ECB_DEADLINE_MS);
      try {
        req = deps.request(
          {
            protocol: 'https:',
            hostname: HOST,
            port: 443,
            path: ECB_PATH,
            method: 'GET',
            headers: { accept: 'application/xml' },
            agent: deps.agent,
            servername: HOST,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
            insecureHTTPParser: false,
          },
          (response: IncomingMessage) => onResponse(response),
        );
      } catch {
        return settleFail('network');
      }
      req.on('error', () => settleFail('network'));

      function onResponse(response: IncomingMessage): void {
        res = response;
        response.on('error', () => settleFail('network'));
        const status = response.statusCode ?? 0;
        if (!Number.isInteger(status) || status < 100 || status > 599) return settleFail('network');
        // A redirect is handed back as a status; its Location is never requested.
        if (status >= 300 && status <= 399) return settle(() => resolve({ status, body: '' }));
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > ECB_MAX_RESPONSE_BYTES)
          return settleFail('too_large');
        const chunks: Buffer[] = [];
        let total = 0;
        let ended = false;
        response.on('data', (chunk: Buffer | string) => {
          if (finished) return;
          const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          total += b.byteLength;
          if (total > ECB_MAX_RESPONSE_BYTES) return settleFail('too_large');
          chunks.push(b);
        });
        response.on('end', () => {
          ended = true;
          settle(() => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
        });
        response.on('close', () => {
          if (!ended) settleFail('network');
        });
      }

      req.end();
    });
  }
  async function fetchRates(): Promise<EcbRates> {
    const { status, body } = await exchange({ method: 'GET', url: ECB_URL });
    if (status >= 300 && status <= 399) throw new EcbError('redirect');
    if (status !== 200) throw new EcbError('status');
    return parseEcbDaily(body);
  }
  return { exchange, fetchRates };
}

// Captured when this module loads, like the other wires do: a later replacement of the platform request
// function does not change what this fetch calls.
const LOADED_REQUEST = https.request;

/**
 * The production fetch: https.request as captured at load, its own agent, no keep-alive. It never throws:
 * it answers the rates or a fixed error kind.
 */
export function createEcbFetch(): () => Promise<EcbFetchResult> {
  const wire = makeEcbFetch({
    request: LOADED_REQUEST,
    agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }),
  });
  return async () => {
    try {
      return { ok: true, ...(await wire.fetchRates()) };
    } catch (e) {
      return { ok: false, kind: e instanceof EcbError ? e.kind : 'network' };
    }
  };
}
