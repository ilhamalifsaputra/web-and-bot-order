/**
 * Zod schema validator for KnowledgeBase.
 *
 * This schema is used by the DB loader (a later task) to validate
 * knowledge base data and reject invalid data loudly instead of
 * silently degrading.
 */

import { z } from "zod";
import type { KnowledgeBase } from "../types";

const tokenCategorySchema = z.enum([
  "platform",
  "distribution",
  "region",
  "edition",
  "denomination",
  "noise",
]);

const knowledgeTokenSchema = z.object({
  category: tokenCategorySchema,
  token: z.string(),
  canonical: z.string(),
  isProductDefining: z.boolean(),
  enabled: z.boolean(),
});

const knowledgeAliasSchema = z.object({
  alias: z.string(),
  expandsTo: z.string(),
  reason: z.string().nullable(),
});

const knowledgeOverrideSchema = z.object({
  matchKind: z.enum(["normalized_name", "external_id"]),
  matchValue: z.string(),
  baseProductKey: z.string(),
  productKey: z.string(),
  reason: z.string(),
});

export const knowledgeBaseSchema: z.ZodType<KnowledgeBase> = z
  .object({
    tokens: z.array(knowledgeTokenSchema).readonly(),
    aliases: z.array(knowledgeAliasSchema).readonly(),
    overrides: z.array(knowledgeOverrideSchema).readonly(),
    externalIdStableBySupplier: z.record(z.string(), z.boolean()).readonly(),
    revision: z.string(),
  })
  .superRefine((data, ctx) => {
    // Check for duplicate [category, token] pairs
    const seen = new Set<string>();
    for (const token of data.tokens) {
      const key = `${token.category}:${token.token}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tokens"],
          message: `Duplicate [category, token] pair: category="${token.category}", token="${token.token}"`,
        });
        return; // Stop after first duplicate found
      }
      seen.add(key);
    }
  });
