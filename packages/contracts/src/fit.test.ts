import { describe, expect, it } from 'vitest';
import { BriefSchema, FitCardSchema, FitDimensionSchema } from './fit';

const dim = {
  key: 'topic',
  label: 'Topic',
  level: 2,
  basis: 'keyword_overlap',
  evidence: '2 of 3 terms',
};
describe('fit', () => {
  it('FitDimension level may be null (no invented scores), 0..3 otherwise', () => {
    expect(FitDimensionSchema.safeParse(dim).success).toBe(true);
    expect(FitDimensionSchema.safeParse({ ...dim, level: null }).success).toBe(true);
    expect(FitDimensionSchema.safeParse({ ...dim, level: 4 }).success).toBe(false);
    expect(FitDimensionSchema.safeParse({ ...dim, level: 1.5 }).success).toBe(false);
  });
  it('FitCard band may be null', () => {
    expect(
      FitCardSchema.safeParse({ offer_id: 'ofr_1', dimensions: [dim], band: null }).success,
    ).toBe(true);
    expect(
      FitCardSchema.safeParse({ offer_id: 'ofr_1', dimensions: [dim], band: 'excellent' }).success,
    ).toBe(false);
  });
  it('Brief', () => {
    const b = {
      brief_id: 'brf_1',
      buyer_id: 'buy_1',
      need: 'n',
      ceiling: { currency: 'USD', minor: 500 },
      option: null,
      language: null,
      terms: ['a'],
      created_at: '2026-10-21T10:00:00Z',
    };
    expect(BriefSchema.safeParse(b).success).toBe(true);
    expect(BriefSchema.safeParse({ ...b, ceiling: { currency: 'USD', minor: -1 } }).success).toBe(
      false,
    );
  });
});
