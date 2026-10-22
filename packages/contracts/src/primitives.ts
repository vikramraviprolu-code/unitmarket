// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/contracts/src/primitives.ts. Adapted; owned by SBX.
// Building blocks for every contract schema. Shapes only, no runtime logic.
import { z } from 'zod';

// Identifier: 1..200 chars, no leading or trailing whitespace (so ' x' and 'x' are never two keys),
// no C0 or C1 control characters, no zero-width characters (U+200B-U+200D, U+2060, U+FEFF) and no
// bidirectional controls (U+202A-U+202E, U+2066-U+2069). The database domain ums_id
// (packages/db/migrations/common/0001_core.sql) refuses exactly the same set.
export const IdSchema = z
  .string()
  .max(200)
  .regex(/^(?:\S|\S[\s\S]*\S)$/)
  .refine(
    (value) =>
      ![...value].some((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return (
          code <= 0x1f ||
          (code >= 0x7f && code <= 0x9f) ||
          (code >= 0x200b && code <= 0x200d) ||
          (code >= 0x202a && code <= 0x202e) ||
          code === 0x2060 ||
          (code >= 0x2066 && code <= 0x2069) ||
          code === 0xfeff
        );
      }),
    { message: 'must not contain control, zero-width or bidirectional characters' },
  );
export type Id = z.infer<typeof IdSchema>;

// Integer >= 0 (never a float, never negative).
export const MinorUnitsSchema = z.number().int().nonnegative();
export type MinorUnits = z.infer<typeof MinorUnitsSchema>;

// Three uppercase letters. Which currencies are sold is policy (corridors), not shape.
export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

// ISO 8601 UTC with a trailing Z only; an offset such as +00:00 is rejected on purpose so the
// canonical text is unique for hashing.
export const IsoUtcSchema = z.iso.datetime();
export type IsoUtc = z.infer<typeof IsoUtcSchema>;

// Lowercase hex sha256.
export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

// Which kind of run produced a record. There is no live value (P15, A-22).
export const EnvironmentLabelSchema = z.enum(['dryrun', 'sandbox']);
export type EnvironmentLabel = z.infer<typeof EnvironmentLabelSchema>;

export const MoneySchema = z
  .object({ currency: CurrencyCodeSchema, minor: MinorUnitsSchema })
  .strict();
export type Money = z.infer<typeof MoneySchema>;
