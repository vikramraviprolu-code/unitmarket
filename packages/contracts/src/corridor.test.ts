import { describe, expect, it } from 'vitest';
import { CorridorSchema } from './corridor';

const c = {
  id: 'us-usd',
  currency: 'USD',
  minor_units: 2,
  buyer_countries: ['US'],
  payee_countries: ['US'],
  domestic_supported: true,
  min_charge_minor: null,
  enabled: true,
};
describe('Corridor', () => {
  it('validates and constrains minor_units', () => {
    expect(CorridorSchema.safeParse(c).success).toBe(true);
    expect(CorridorSchema.safeParse({ ...c, minor_units: 0 }).success).toBe(true);
    expect(CorridorSchema.safeParse({ ...c, minor_units: 3 }).success).toBe(true);
    expect(CorridorSchema.safeParse({ ...c, minor_units: 1 }).success).toBe(false);
    expect(CorridorSchema.safeParse({ ...c, currency: 'usd' }).success).toBe(false);
    expect(CorridorSchema.safeParse({ ...c, extra: 1 }).success).toBe(false);
  });
});
