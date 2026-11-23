/** Read-only projection of a DSH standard model catalog. No session and no prompt. */
import { z } from 'zod';

const id = z.string().min(1).max(256);
const effort = z.object({ id, name: z.string().min(1).max(256) }).strict();
const model = z.object({
  id, name: z.string().min(1).max(512),
  routingGroup: z.literal(true).optional(),
  reasoning: z.object({ efforts: z.array(effort).max(32), defaultEffort: id.optional() }).strict().optional(),
}).strict();

/** Ids a caller can pass as provider and model. Failure text from a provider is not included. */
export const a2aModelCatalogSchema = z.object({
  default: z.object({ provider: id, model: id }).strict(),
  groups: z.array(z.object({ id, name: z.string().min(1).max(512), models: z.array(model).max(500) }).strict()).max(100),
  failures: z.array(z.object({ id, name: z.string().min(1).max(512) }).strict()).max(100),
}).strict();
export type A2AModelCatalog = z.output<typeof a2aModelCatalogSchema>;
