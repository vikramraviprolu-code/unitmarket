import { z } from 'zod';
import { AccessEventKindSchema, WindowStateSchema } from './access';
import { ApprovalSnapshotSchema } from './approval';
import { AccessOptionSchema } from './catalogue';
import {
  EnvironmentLabelSchema,
  IdSchema,
  IsoUtcSchema,
  MinorUnitsSchema,
  MoneySchema,
  Sha256HexSchema,
} from './primitives';

export const ReceiptLineSchema = z
  .object({
    article_id: IdSchema,
    article_sha256: Sha256HexSchema,
    option: AccessOptionSchema,
    amount_minor: MinorUnitsSchema,
    capture_id: z.string().nullable(),
    window: WindowStateSchema,
    delivery: z.array(z.object({ kind: AccessEventKindSchema, at: IsoUtcSchema }).strict()),
  })
  .strict();
export type ReceiptLine = z.infer<typeof ReceiptLineSchema>;

export const ReceiptSchema = z
  .object({
    receipt_id: IdSchema,
    order_id: IdSchema,
    version: z.number().int().positive(),
    snapshot: ApprovalSnapshotSchema,
    content_hash: Sha256HexSchema,
    lines: z.array(ReceiptLineSchema),
    refunds: z.array(
      z.object({ refund_id: z.string().min(1), amount: MoneySchema, at: IsoUtcSchema }).strict(),
    ),
    debug_ids: z.array(z.string()),
    sha256: Sha256HexSchema,
    created_at: IsoUtcSchema,
    environment: EnvironmentLabelSchema,
  })
  .strict();
export type Receipt = z.infer<typeof ReceiptSchema>;
