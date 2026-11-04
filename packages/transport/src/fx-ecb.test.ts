import https from 'node:https';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRequest } from './https-fake';
import type { Script } from './https-fake';
import { netSpies } from './test-support';
import {
  ECB_API,
  ECB_DEADLINE_MS,
  ECB_MAX_RESPONSE_BYTES,
  ECB_PATH,
  EcbError,
  createEcbFetch,
  makeEcbFetch,
  parseEcbDaily,
} from './fx-ecb';

// MC2-L4 (D-085). The ECB rate fetch: one host, one path, GET, no credentials, no redirect, 64 KB,
// 3 s, a strict hand parser. Every test uses an in-memory request function: no socket, no lookup,
// no fetch. netSpies() proves nothing real is touched.
const SAMPLE = readFileSync(
  new URL('../test-data/ecb-eurofxref-daily.xml', import.meta.url),
  'utf8',
);

let spies: ReturnType<typeof netSpies>;
beforeEach(() => {
  spies = netSpies();
});
afterEach(() => {
  vi.useRealTimers();
  spies.assertZero();
  spies.spies['global fetch'].mockRestore();
});

function build(script?: Script) {
  const { request, calls } = fakeRequest(script);
  const wire = makeEcbFetch({
    request: request as unknown as typeof https.request,
    agent: new https.Agent({ keepAlive: false }),
  });
  return { wire, calls };
}
const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return e instanceof EcbError ? e.kind : `other:${String(e)}`;
  }
  return 'resolved';
};
const parseKind = (xml: string): string => {
  try {
    parseEcbDaily(xml);
  } catch (e) {
    return e instanceof EcbError ? e.kind : `other:${String(e)}`;
  }
  return 'parsed';
};
/** The sample with its USD or GBP rate attribute replaced. */
const withRate = (cur: 'USD' | 'GBP', rate: string): string =>
  SAMPLE.replace(new RegExp(`currency='${cur}' rate='[^']*'`), `currency='${cur}' rate='${rate}'`);
const withoutCube = (cur: string): string =>
  SAMPLE.replace(new RegExp(`\\s*<Cube currency='${cur}' rate='[^']*'/>`), '');

describe('the limits are the D-085 numbers', () => {
  it('one host, one path, 64 KB in, 3 s', () => {
    expect(ECB_API).toBe('https://www.ecb.europa.eu');
    expect(ECB_PATH).toBe('/stats/eurofxref/eurofxref-daily.xml');
    expect(ECB_MAX_RESPONSE_BYTES).toBe(64 * 1024);
    expect(ECB_DEADLINE_MS).toBe(3000);
  });
});

describe('parseEcbDaily', () => {
  it('reads the date and the USD and GBP rates as decimal strings', () => {
    expect(parseEcbDaily(SAMPLE)).toEqual({ date: '2026-11-03', usd: '1.1612', gbp: '0.8731' });
  });
  it('ignores currencies other than USD and GBP, whatever their rate says', () => {
    const odd = SAMPLE.replace("currency='JPY' rate='177.35'", "currency='JPY' rate='n/a'");
    expect(parseEcbDaily(odd)).toEqual({ date: '2026-11-03', usd: '1.1612', gbp: '0.8731' });
    const more = SAMPLE.replace(
      "<Cube currency='CAD' rate='1.6275'/>",
      "<Cube currency='CAD' rate='1.6275'/><Cube currency='XAU' rate='0.0003'/><Cube currency='ZAR' rate='20.1'/>",
    );
    expect(parseEcbDaily(more).usd).toBe('1.1612');
  });
  it('refuses a truncated file', () => {
    expect(parseKind(SAMPLE.slice(0, SAMPLE.indexOf("currency='GBP'")))).toBe('bad_shape');
    expect(parseKind(SAMPLE.slice(0, SAMPLE.length - 20))).toBe('bad_shape');
    expect(parseKind('')).toBe('bad_shape');
  });
  it('refuses a wrong envelope', () => {
    expect(parseKind('<html><body>maintenance</body></html>')).toBe('bad_shape');
    expect(parseKind(SAMPLE.replace('gesmes:Envelope', 'gesmes:Other'))).toBe('bad_shape');
    expect(parseKind(SAMPLE.replace('European Central Bank', 'Somebody Else'))).toBe('bad_shape');
    expect(parseKind(SAMPLE.replace('http://www.ecb.int/vocabulary', 'http://x.invalid/v'))).toBe(
      'bad_shape',
    );
  });
  it('refuses a document type, an entity, a comment or a processing instruction', () => {
    const decl = '<?xml version="1.0" encoding="UTF-8"?>';
    expect(parseKind(SAMPLE.replace(decl, `${decl}<!DOCTYPE x [<!ENTITY a "b">]>`))).toBe(
      'bad_shape',
    );
    expect(parseKind(SAMPLE.replace('<Cube>', '<!-- note --><Cube>'))).toBe('bad_shape');
    expect(parseKind(SAMPLE.replace('<Cube>', '<?pi x?><Cube>'))).toBe('bad_shape');
  });
  it('refuses an extra element, a second date block or a repeated currency', () => {
    expect(parseKind(SAMPLE.replace('</Cube>\n</gesmes', '<script/></Cube>\n</gesmes'))).toBe(
      'bad_shape',
    );
    const block = "<Cube time='2026-11-02'><Cube currency='USD' rate='1.1'/></Cube>";
    expect(parseKind(SAMPLE.replace('\t</Cube>\n</gesmes', `${block}\t</Cube>\n</gesmes`))).toBe(
      'bad_shape',
    );
    expect(
      parseKind(
        SAMPLE.replace(
          "<Cube currency='CHF'",
          "<Cube currency='USD' rate='1.2'/><Cube currency='CHF'",
        ),
      ),
    ).toBe('bad_shape');
  });
  it('refuses a file without USD or without GBP', () => {
    expect(parseKind(withoutCube('GBP'))).toBe('missing_currency');
    expect(parseKind(withoutCube('USD'))).toBe('missing_currency');
  });
  it('refuses a rate that is not a finite number above zero', () => {
    for (const bad of [
      '0',
      '0.0000',
      '-1.1612',
      'NaN',
      'Infinity',
      '-Infinity',
      '1e3',
      '',
      '1,16',
      ' 1.16',
      '1.16 ',
      '0x10',
      '1.1.1',
      '.5',
      '1.',
    ]) {
      expect(parseKind(withRate('USD', bad)), `USD ${JSON.stringify(bad)}`).toBe('bad_rate');
      expect(parseKind(withRate('GBP', bad)), `GBP ${JSON.stringify(bad)}`).toBe('bad_rate');
    }
  });
  it('refuses a date that is not a real calendar date', () => {
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '2026-00-10',
      '2026-11-00',
      '2026-11-3',
      '26-11-03',
      '2026/11/03',
      '',
    ]) {
      expect(parseKind(SAMPLE.replace("time='2026-11-03'", `time='${bad}'`)), bad).toBe('bad_date');
    }
    expect(parseKind(SAMPLE.replace("time='2026-11-03'", "time='2028-02-29'"))).toBe('parsed');
  });
  it('refuses a body over 64 KB even when it starts like the sample', () => {
    const big = SAMPLE.replace(
      '</Cube>\n</gesmes',
      `${' '.repeat(ECB_MAX_RESPONSE_BYTES)}</Cube>\n</gesmes`,
    );
    expect(parseKind(big)).toBe('too_large');
  });
});

describe('fetchRates', () => {
  it('GETs the one host and path once, with no body and only the Accept header', async () => {
    const { wire, calls } = build({ kind: 'response', status: 200, chunks: [SAMPLE] });
    expect(await wire.fetchRates()).toEqual({ date: '2026-11-03', usd: '1.1612', gbp: '0.8731' });
    expect(calls).toHaveLength(1);
    const o = calls[0]!.options;
    expect(o['method']).toBe('GET');
    expect(o['protocol']).toBe('https:');
    expect(o['hostname']).toBe('www.ecb.europa.eu');
    expect(o['port']).toBe(443);
    expect(o['path']).toBe('/stats/eurofxref/eurofxref-daily.xml');
    expect(o['headers']).toEqual({ accept: 'application/xml' });
    expect(o['auth']).toBeUndefined();
    expect(o['rejectUnauthorized']).toBe(true);
    expect(o['minVersion']).toBe('TLSv1.2');
    expect(o['servername']).toBe('www.ecb.europa.eu');
    expect(o['insecureHTTPParser']).toBe(false);
    expect(calls[0]!.body).toBe('');
    expect(calls[0]!.ended).toBe(true);
  });
  it('does not follow a redirect: one request, error kind redirect', async () => {
    const { wire, calls } = build({
      kind: 'response',
      status: 301,
      headers: { Location: 'https://elsewhere.invalid/x.xml' },
      chunks: ['moved'],
    });
    expect(await kindOf(wire.fetchRates())).toBe('redirect');
    expect(calls).toHaveLength(1);
  });
  it('fails with timeout at 3 s and destroys the request', async () => {
    vi.useFakeTimers();
    const { wire, calls } = build({ kind: 'hang' });
    const p = kindOf(wire.fetchRates());
    await vi.advanceTimersByTimeAsync(ECB_DEADLINE_MS - 1);
    expect(calls[0]!.reqDestroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe('timeout');
    expect(calls[0]!.reqDestroyed).toBe(true);
  });
  it('a body that stalls fails at the same deadline', async () => {
    vi.useFakeTimers();
    const { wire } = build({ kind: 'stall-body', chunks: ['<?xml'] });
    const p = kindOf(wire.fetchRates());
    await vi.advanceTimersByTimeAsync(ECB_DEADLINE_MS);
    expect(await p).toBe('timeout');
  });
  it('refuses an oversize body, declared or streamed', async () => {
    const declared = build({
      kind: 'response',
      headers: { 'content-length': String(ECB_MAX_RESPONSE_BYTES + 1) },
      chunks: [SAMPLE],
    });
    expect(await kindOf(declared.wire.fetchRates())).toBe('too_large');
    const streamed = build({ kind: 'response', chunks: ['a'.repeat(ECB_MAX_RESPONSE_BYTES), 'b'] });
    expect(await kindOf(streamed.wire.fetchRates())).toBe('too_large');
    expect(streamed.calls[0]!.resDestroyed).toBe(true);
  });
  it('turns any status other than 200 into the kind status', async () => {
    for (const status of [201, 204, 400, 403, 404, 429, 500, 503]) {
      const { wire } = build({ kind: 'response', status, chunks: [SAMPLE] });
      expect(await kindOf(wire.fetchRates()), String(status)).toBe('status');
    }
  });
  it('turns a request error or a reset into network', async () => {
    expect(
      await kindOf(build({ kind: 'request-error', code: 'ECONNRESET' }).wire.fetchRates()),
    ).toBe('network');
    expect(
      await kindOf(build({ kind: 'response', chunks: ['<?xml'], then: 'reset' }).wire.fetchRates()),
    ).toBe('network');
  });
  it('turns a 200 with a bad file into the parser kind', async () => {
    expect(await kindOf(build({ kind: 'response', chunks: ['<html/>'] }).wire.fetchRates())).toBe(
      'bad_shape',
    );
    expect(
      await kindOf(build({ kind: 'response', chunks: [withRate('USD', '0')] }).wire.fetchRates()),
    ).toBe('bad_rate');
  });
  it('refuses another host, scheme, path, query or method before a socket exists', async () => {
    const bad: { method: string; url: string }[] = [
      { method: 'GET', url: 'https://evil.example/stats/eurofxref/eurofxref-daily.xml' },
      {
        method: 'GET',
        url: 'https://www.ecb.europa.eu.evil.example/stats/eurofxref/eurofxref-daily.xml',
      },
      { method: 'GET', url: 'http://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml' },
      { method: 'GET', url: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml' },
      { method: 'GET', url: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml?x=1' },
      {
        method: 'GET',
        url: 'https://user:pw@www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
      },
      { method: 'POST', url: `${ECB_API}${ECB_PATH}` },
      { method: 'get', url: `${ECB_API}${ECB_PATH}` },
    ];
    for (const r of bad) {
      const { wire, calls } = build();
      expect(await kindOf(wire.exchange(r)), `${r.method} ${r.url}`).toBe('refused');
      expect(calls).toHaveLength(0);
    }
    const ok = build({ kind: 'response', chunks: ['x'] });
    expect(await ok.wire.exchange({ method: 'GET', url: `${ECB_API}${ECB_PATH}` })).toEqual({
      status: 200,
      body: 'x',
    });
  });
});

describe('createEcbFetch', () => {
  it('is a function that never throws: it answers ok or a fixed kind', () => {
    expect(typeof createEcbFetch).toBe('function');
    const f = createEcbFetch();
    expect(typeof f).toBe('function');
  });
});
