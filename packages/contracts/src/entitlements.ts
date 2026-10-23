// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/contracts/src/entitlement.ts. Adapted; owned by SBX.
import { z } from 'zod';
import type { MoneyEvent } from './payments';

export const AccessStateSchema = z.enum(['locked', 'available', 'ended', 'revoked']);
export type AccessState = z.infer<typeof AccessStateSchema>;
export const LicenceStateSchema = z.enum(['granted', 'terminated']);
export type LicenceState = z.infer<typeof LicenceStateSchema>;

/**
 * Money events the entitlement table accepts: the six payments-facing events plus
 * `partial_refund_verified` (CO-5, ASM-59). A partial refund leaves the money state, the access
 * state and the licence as they are (the buyer keeps what was not refunded). Type-level only:
 * `MoneyEventSchema` keeps its six values, so no runtime export is added.
 */
export type EntitlementMoneyEvent = MoneyEvent | 'partial_refund_verified';
