import { describe, expect, it } from 'vitest';
import { ActorSchema } from './actor';

describe('ActorSchema', () => {
  it('accepts the four kinds', () => {
    for (const a of [
      { kind: 'buyer', buyer_id: 'buy_1' },
      { kind: 'publisher', publisher_id: 'pub_1' },
      { kind: 'operator', operator_id: 'op_1', mfa: true },
      { kind: 'system' },
    ]) {
      expect(ActorSchema.safeParse(a).success).toBe(true);
    }
  });
  it('refuses unknown kind, missing mfa and extra keys', () => {
    expect(ActorSchema.safeParse({ kind: 'admin' }).success).toBe(false);
    expect(ActorSchema.safeParse({ kind: 'operator', operator_id: 'op_1' }).success).toBe(false);
    expect(ActorSchema.safeParse({ kind: 'system', role: 'root' }).success).toBe(false);
    expect(ActorSchema.safeParse({ kind: 'buyer', buyer_id: 'buy_1', mfa: true }).success).toBe(
      false,
    );
  });
});
