// Type-level checks only (deps are interfaces with no runtime value); run by tsc in typecheck.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AgentDeps, CoreDeps, PaymentsDeps } from './deps';
import type { ModelPort } from './ports';

describe('deps types', () => {
  it('AgentDeps extends CoreDeps with model only; PaymentsDeps adds paypal and content', () => {
    expectTypeOf<AgentDeps['model']>().toEqualTypeOf<ModelPort>();
    expectTypeOf<AgentDeps>().toExtend<CoreDeps>();
    expectTypeOf<PaymentsDeps>().toExtend<CoreDeps>();
    expectTypeOf<keyof PaymentsDeps>().toExtend<keyof CoreDeps | 'paypal' | 'content'>();
    expectTypeOf<keyof AgentDeps>().toExtend<keyof CoreDeps | 'model'>();
    expect(true).toBe(true);
  });
  it('AgentDeps never carries paypal or content', () => {
    expectTypeOf<'paypal' extends keyof AgentDeps ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'content' extends keyof AgentDeps ? true : false>().toEqualTypeOf<false>();
  });
});
