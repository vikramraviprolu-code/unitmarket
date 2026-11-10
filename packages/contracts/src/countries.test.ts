import { describe, expect, it } from 'vitest';
import {
  INDIA_COUNTRY,
  ISO_3166_1_ALPHA2,
  WORLDWIDE_PAYEE_COUNTRIES,
  isIsoCountry,
} from './countries';

describe('ISO_3166_1_ALPHA2: the one country list', () => {
  it('holds the 249 assigned codes, upper case, sorted, no duplicates', () => {
    expect(ISO_3166_1_ALPHA2).toHaveLength(249);
    expect(new Set(ISO_3166_1_ALPHA2).size).toBe(249);
    expect(ISO_3166_1_ALPHA2.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
    expect([...ISO_3166_1_ALPHA2]).toEqual([...ISO_3166_1_ALPHA2].sort());
  });

  it('knows the countries the sandbox uses and none of the look-alikes', () => {
    for (const c of ['US', 'GB', 'DE', 'FR', 'IN', 'JP', 'AX', 'ZW'])
      expect(isIsoCountry(c), c).toBe(true);
    // UK, EU and ZZ pass a two-letter shape check but are not ISO 3166-1 alpha-2 country codes.
    for (const c of ['UK', 'EU', 'ZZ', 'XK', 'AN', 'gb', 'GBR', '', 'U', ' US', 'US '])
      expect(isIsoCountry(c), JSON.stringify(c)).toBe(false);
    for (const c of [undefined, null, 5, {}, ['US']]) expect(isIsoCountry(c)).toBe(false);
  });

  it('the worldwide payee set is every code except India', () => {
    expect(INDIA_COUNTRY).toBe('IN');
    expect(WORLDWIDE_PAYEE_COUNTRIES).toHaveLength(248);
    expect(WORLDWIDE_PAYEE_COUNTRIES).not.toContain('IN');
    expect([...WORLDWIDE_PAYEE_COUNTRIES, 'IN'].sort()).toEqual([...ISO_3166_1_ALPHA2]);
  });
});
