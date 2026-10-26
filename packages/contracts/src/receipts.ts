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

// What happened to the payment of one item of a two-publisher order (MVP-D, OQ-16). `not_charged` is
// said only of a declined, failed or abandoned PayPal order; a frozen one is `on_hold`. The schema
// is not exported (the contracts index test lists its exports exactly); use ReceiptLine['outcome'].
const ReceiptOutcomeSchema = z.enum([
  'paid',
  'not_charged',
  'waiting',
  'on_hold',
  'refunded',
  'partially_refunded',
]);

export const ReceiptLineSchema = z
  .object({
    article_id: IdSchema,
    article_sha256: Sha256HexSchema,
    option: AccessOptionSchema,
    amount_minor: MinorUnitsSchema,
    capture_id: z.string().nullable(),
    window: WindowStateSchema,
    delivery: z.array(z.object({ kind: AccessEventKindSchema, at: IsoUtcSchema }).strict()),
    // Only a line of a two-publisher order carries these two keys, and it carries both. A receipt
    // stored before MVP-D has neither, and a one-publisher receipt is still written without them,
    // so its hash is what it always was. No merchant id here: the publisher is named, not its payee.
    publisher_display_name: z.string().min(1).optional(),
    outcome: ReceiptOutcomeSchema.optional(),
  })
  .strict()
  .superRefine((line, ctx) => {
    if ((line.publisher_display_name === undefined) !== (line.outcome === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'publisher_display_name and outcome come together',
        path: [line.outcome === undefined ? 'outcome' : 'publisher_display_name'],
      });
    }
  });
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
