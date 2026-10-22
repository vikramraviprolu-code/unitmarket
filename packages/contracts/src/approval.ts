// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/contracts/src/{snapshot,approval,expected-transaction}.ts. Adapted; owned by SBX.
// The frozen accepted offer, the approval that wraps it and the transaction payments expects.
import { z } from 'zod';
import { AccessOptionSchema, AccessPolicySchema, RightsSchema } from './catalogue';
import { CorridorIdSchema } from './corridor';
import {
  CurrencyCodeSchema,
  EnvironmentLabelSchema,
  IdSchema,
  IsoUtcSchema,
  MinorUnitsSchema,
  Sha256HexSchema,
} from './primitives';

export const SnapshotItemSchema = z
  .object({
    article_id: IdSchema,
    article_sha256: Sha256HexSchema,
    offer_id: IdSchema,
    offer_version: z.string().min(1),
    terms_version: z.string().min(1),
    publisher_id: IdSchema,
    payee_merchant_id: IdSchema,
    option: AccessOptionSchema,
    policy: AccessPolicySchema,
    rights: RightsSchema,
    amount_minor: MinorUnitsSchema,
  })
  .strict();
export type SnapshotItem = z.infer<typeof SnapshotItemSchema>;

export const SnapshotPublisherSchema = z
  .object({
    publisher_id: IdSchema,
    payee_merchant_id: IdSchema,
    amount_minor: MinorUnitsSchema,
    platform_fee_minor: z.literal(0),
  })
  .strict();
export type SnapshotPublisher = z.infer<typeof SnapshotPublisherSchema>;

// Refinements: unique article ids; every item has a publisher block with the same payee; each
// publisher amount equals the sum of its items; the total equals the sum of publishers. A snapshot
// has one currency field and items carry none, so a second currency cannot be expressed (strict).
export const ApprovalSnapshotSchema = z
  .object({
    snapshot_version: z.literal('1'),
    items: z.array(SnapshotItemSchema).min(1),
    publishers: z.array(SnapshotPublisherSchema).min(1),
    total_minor: MinorUnitsSchema,
    currency: CurrencyCodeSchema,
    corridor_id: CorridorIdSchema,
    reader: z.object({ buyer_id: IdSchema }).strict(),
    rule_version: z.string().min(1),
    pricing_rule_version: z.string().min(1),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path });

    const byPublisher = new Map<string, z.infer<typeof SnapshotPublisherSchema>>();
    snapshot.publishers.forEach((publisher, index) => {
      if (byPublisher.has(publisher.publisher_id)) {
        issue('duplicate publisher_id', ['publishers', index, 'publisher_id']);
      }
      byPublisher.set(publisher.publisher_id, publisher);
    });

    const articles = new Set<string>();
    const itemSums = new Map<string, number>();
    snapshot.items.forEach((item, index) => {
      if (articles.has(item.article_id)) {
        issue('duplicate article_id', ['items', index, 'article_id']);
      }
      articles.add(item.article_id);
      const publisher = byPublisher.get(item.publisher_id);
      if (publisher === undefined) {
        issue('item publisher has no publisher block', ['items', index, 'publisher_id']);
        return;
      }
      if (publisher.payee_merchant_id !== item.payee_merchant_id) {
        issue('item payee differs from its publisher block', ['items', index, 'payee_merchant_id']);
      }
      itemSums.set(item.publisher_id, (itemSums.get(item.publisher_id) ?? 0) + item.amount_minor);
    });

    snapshot.publishers.forEach((publisher, index) => {
      if (!itemSums.has(publisher.publisher_id)) {
        issue('publisher block has no items', ['publishers', index, 'publisher_id']);
      } else if (itemSums.get(publisher.publisher_id) !== publisher.amount_minor) {
        issue('publisher amount_minor must equal the sum of its items', [
          'publishers',
          index,
          'amount_minor',
        ]);
      }
    });

    const publisherTotal = snapshot.publishers.reduce((sum, p) => sum + p.amount_minor, 0);
    if (publisherTotal !== snapshot.total_minor) {
      issue('total_minor must equal the sum of publisher amounts', ['total_minor']);
    }
  });
export type ApprovalSnapshot = z.infer<typeof ApprovalSnapshotSchema>;

export const APPROVAL_TTL_MS = 900000;

export const ApprovalSchema = z
  .object({
    approval_id: IdSchema,
    buyer_id: IdSchema,
    snapshot: ApprovalSnapshotSchema,
    content_hash: Sha256HexSchema,
    /** 128 bits as 32 hex chars */
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    created_at: IsoUtcSchema,
    /** created_at + 15 min */
    expires_at: IsoUtcSchema,
    used_at: IsoUtcSchema.nullable(),
    environment: EnvironmentLabelSchema,
  })
  .strict()
  .superRefine((a, ctx) => {
    if (Date.parse(a.expires_at) - Date.parse(a.created_at) !== APPROVAL_TTL_MS) {
      ctx.addIssue({
        code: 'custom',
        message: 'expires_at must equal created_at + 15 minutes',
        path: ['expires_at'],
      });
    }
    if (a.buyer_id !== a.snapshot.reader.buyer_id) {
      ctx.addIssue({
        code: 'custom',
        message: 'buyer_id must equal snapshot.reader.buyer_id',
        path: ['buyer_id'],
      });
    }
    if (a.used_at !== null && Date.parse(a.used_at) > Date.parse(a.expires_at)) {
      ctx.addIssue({
        code: 'custom',
        message: 'used_at must not be later than expires_at',
        path: ['used_at'],
      });
    }
  });
export type Approval = z.infer<typeof ApprovalSchema>;

export const ExpectedUnitSchema = z
  .object({
    reference_id: IdSchema,
    publisher_id: IdSchema,
    payee_merchant_id: IdSchema,
    amount_minor: MinorUnitsSchema,
  })
  .strict();
export type ExpectedUnit = z.infer<typeof ExpectedUnitSchema>;

export const ExpectedTransactionSchema = z
  .object({
    order_ref: IdSchema,
    buyer_id: IdSchema,
    content_hash: Sha256HexSchema,
    currency: CurrencyCodeSchema,
    total_minor: MinorUnitsSchema,
    units: z.array(ExpectedUnitSchema).min(1),
    created_at: IsoUtcSchema,
    environment: EnvironmentLabelSchema,
  })
  .strict()
  .superRefine((e, ctx) => {
    const refs = new Set<string>();
    e.units.forEach((unit, index) => {
      if (refs.has(unit.reference_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate reference_id',
          path: ['units', index, 'reference_id'],
        });
      }
      refs.add(unit.reference_id);
    });
    const sum = e.units.reduce((total, unit) => total + unit.amount_minor, 0);
    if (sum !== e.total_minor) {
      ctx.addIssue({
        code: 'custom',
        message: 'total_minor must equal the sum of unit amounts',
        path: ['total_minor'],
      });
    }
  });
export type ExpectedTransaction = z.infer<typeof ExpectedTransactionSchema>;
