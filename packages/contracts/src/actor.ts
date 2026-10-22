import { z } from 'zod';
import { IdSchema } from './primitives';

export const ActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('buyer'), buyer_id: IdSchema }).strict(),
  z.object({ kind: z.literal('publisher'), publisher_id: IdSchema }).strict(),
  z.object({ kind: z.literal('operator'), operator_id: IdSchema, mfa: z.boolean() }).strict(),
  z.object({ kind: z.literal('system') }).strict(),
]);
export type Actor = z.infer<typeof ActorSchema>;
