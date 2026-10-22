import { z } from 'zod';
import { CurrencyCodeSchema, MinorUnitsSchema } from './primitives';

// e.g. 'us-usd'. Which corridors are enabled is configuration, not code (architecture 12).
export const CorridorIdSchema = z.string().min(1).max(64);
export type CorridorId = z.infer<typeof CorridorIdSchema>;

export const CorridorSchema = z
  .object({
    id: CorridorIdSchema,
    currency: CurrencyCodeSchema,
    minor_units: z.union([z.literal(0), z.literal(2), z.literal(3)]),
    buyer_countries: z.array(z.string()),
    payee_countries: z.array(z.string()),
    domestic_supported: z.boolean(),
    min_charge_minor: MinorUnitsSchema.nullable(),
    enabled: z.boolean(),
  })
  .strict();
export type Corridor = z.infer<typeof CorridorSchema>;
