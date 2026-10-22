import { describe, expect, it } from 'vitest';
import { AccessStateSchema, LicenceStateSchema } from './entitlements';

describe('entitlements', () => {
  it('state enums', () => {
    expect([...AccessStateSchema.options]).toEqual(['locked', 'available', 'ended', 'revoked']);
    expect([...LicenceStateSchema.options]).toEqual(['granted', 'terminated']);
  });
});
