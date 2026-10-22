// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/contracts/src/entitlement.ts. Adapted; owned by SBX.
import { z } from 'zod';

export const AccessStateSchema = z.enum(['locked', 'available', 'ended', 'revoked']);
export type AccessState = z.infer<typeof AccessStateSchema>;
export const LicenceStateSchema = z.enum(['granted', 'terminated']);
export type LicenceState = z.infer<typeof LicenceStateSchema>;
