import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeRequest } from './https-fake';
import { netSpies } from './test-support';
import { EcbError, makeEcbFetch, parseEcbDaily } from './fx-ecb';

// MC2-L4 (D-085). Hostile peers: the errors keep a fixed kind and none of the peer's text, and nothing
// real is touched.
let spies: ReturnType<typeof netSpies>;
beforeEach(() => {
  spies = netSpies();
});
afterEach(() => {
  spies.assertZero();
  spies.spies['global fetch'].mockRestore();
});

const PEER = 'PEER-TEXT-SECRET-0001 https://elsewhere.invalid/leak';
async function failure(chunks: string[], status = 200): Promise<unknown> {
  const { request } = fakeRequest({ kind: 'response', status, chunks });
  const wire = makeEcbFetch({
    request: request as unknown as typeof https.request,
    agent: new https.Agent({ keepAlive: false }),
  });
  try {
    await wire.fetchRates();
  } catch (e) {
    return e;
  }
  throw new Error('expected a failure');
}

describe('errors carry a fixed kind and no peer text', () => {
  it('for a bad body, a bad status and a refused redirect', async () => {
    const errs = [
      await failure([PEER]),
      await failure([`<html>${PEER}</html>`], 503),
      await failure([PEER], 302),
      await failure([`<?xml version="1.0"?><x a="${PEER}"/>`]),
    ];
    for (const e of errs) {
      expect(e).toBeInstanceOf(EcbError);
      const text = `${String(e)} ${JSON.stringify(e)} ${(e as Error).message} ${(e as Error).stack ?? ''}`;
      expect(text).not.toContain('PEER-TEXT');
      expect(text).not.toContain('elsewhere.invalid');
      expect(Object.keys(e as object).filter((k) => k !== 'kind' && k !== 'name')).toEqual([]);
    }
  });
});

describe('the parser is not a general XML reader', () => {
  it('never throws anything but EcbError, whatever it is given', () => {
    const junk = [
      '\u0000',
      '<'.repeat(5000),
      '<Cube '.repeat(2000),
      'a'.repeat(100_000),
      '\ufeff<?xml',
      '<![CDATA[x]]>',
      "<Cube currency='USD' rate='1'/>",
    ];
    for (const j of junk) {
      try {
        parseEcbDaily(j);
        throw new Error('parsed junk');
      } catch (e) {
        expect(e).toBeInstanceOf(EcbError);
      }
    }
  });
});
