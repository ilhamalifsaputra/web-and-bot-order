/**
 * Tests for Knowledge Base schema validation.
 *
 * Validates that:
 * - DEFAULT_KNOWLEDGE_BASE passes the zod schema
 * - Malformed objects are rejected with clear errors
 * - Missing/wrong-type/duplicate fields are caught
 */

import { describe, it, expect } from "vitest";
import { knowledgeBaseSchema } from "./schema";
import { DEFAULT_KNOWLEDGE_BASE } from "./defaultVocabulary";
import type { KnowledgeBase } from "../types";

describe("knowledgeBaseSchema", () => {
  describe("valid data", () => {
    it("accepts DEFAULT_KNOWLEDGE_BASE", () => {
      const result = knowledgeBaseSchema.safeParse(DEFAULT_KNOWLEDGE_BASE);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(DEFAULT_KNOWLEDGE_BASE);
      }
    });

    it("accepts a minimal valid KnowledgeBase", () => {
      const minimal: KnowledgeBase = {
        tokens: [],
        aliases: [],
        overrides: [],
        externalIdStableBySupplier: {},
        revision: "test",
      };
      const result = knowledgeBaseSchema.safeParse(minimal);
      expect(result.success).toBe(true);
    });

    it("accepts a KnowledgeBase with tokens, aliases, and overrides", () => {
      const data: KnowledgeBase = {
        tokens: [
          {
            category: "platform",
            token: "test",
            canonical: "test",
            isProductDefining: true,
            enabled: true,
          },
        ],
        aliases: [
          {
            alias: "tst",
            expandsTo: "test",
            reason: "abbreviation",
          },
        ],
        overrides: [
          {
            matchKind: "normalized_name",
            matchValue: "test",
            baseProductKey: "base",
            productKey: "product",
            reason: "manual override",
          },
        ],
        externalIdStableBySupplier: { supplier1: true },
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });

  describe("invalid data — missing fields", () => {
    it("rejects missing tokens field", () => {
      const invalid = {
        aliases: [],
        overrides: [],
        externalIdStableBySupplier: {},
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        const error = result.error!;
        expect(error.issues.length).toBeGreaterThan(0);
        const issue = error.issues[0]!;
        expect(issue.path).toContain("tokens");
      }
    });

    it("rejects missing revision field", () => {
      const invalid = {
        tokens: [],
        aliases: [],
        overrides: [],
        externalIdStableBySupplier: {},
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        const error = result.error!;
        expect(error.issues.length).toBeGreaterThan(0);
        const issue = error.issues[0]!;
        expect(issue.path).toContain("revision");
      }
    });

    it("rejects missing externalIdStableBySupplier field", () => {
      const invalid = {
        tokens: [],
        aliases: [],
        overrides: [],
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        const error = result.error!;
        expect(error.issues.length).toBeGreaterThan(0);
        const issue = error.issues[0]!;
        expect(issue.path).toContain("externalIdStableBySupplier");
      }
    });
  });

  describe("invalid data — wrong types", () => {
    it("rejects non-array tokens", () => {
      const invalid = {
        tokens: "not an array",
        aliases: [],
        overrides: [],
        externalIdStableBySupplier: {},
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects non-string revision", () => {
      const invalid = {
        tokens: [],
        aliases: [],
        overrides: [],
        externalIdStableBySupplier: {},
        revision: 123,
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects non-object externalIdStableBySupplier", () => {
      const invalid = {
        tokens: [],
        aliases: [],
        overrides: [],
        externalIdStableBySupplier: "not an object",
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects externalIdStableBySupplier with non-boolean values", () => {
      const invalid = {
        tokens: [],
        aliases: [],
        overrides: [],
        externalIdStableBySupplier: { supplier1: "not a boolean" },
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe("invalid token data — wrong types", () => {
    it("rejects token with missing category", () => {
      const invalid = {
        tokens: [
          {
            token: "test",
            canonical: "test",
            isProductDefining: true,
            enabled: true,
          },
        ],
        aliases: [],
        overrides: [],
        externalIdStableBySupplier: {},
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects token with invalid category", () => {
      const invalid = {
        tokens: [
          {
            category: "invalid_category",
            token: "test",
            canonical: "test",
            isProductDefining: true,
            enabled: true,
          },
        ],
        aliases: [],
        overrides: [],
        externalIdStableBySupplier: {},
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects token with non-string token field", () => {
      const invalid = {
        tokens: [
          {
            category: "platform",
            token: 123,
            canonical: "test",
            isProductDefining: true,
            enabled: true,
          },
        ],
        aliases: [],
        overrides: [],
        externalIdStableBySupplier: {},
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects token with non-boolean isProductDefining", () => {
      const invalid = {
        tokens: [
          {
            category: "platform",
            token: "test",
            canonical: "test",
            isProductDefining: "yes",
            enabled: true,
          },
        ],
        aliases: [],
        overrides: [],
        externalIdStableBySupplier: {},
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe("invalid alias data", () => {
    it("rejects alias with non-string alias field", () => {
      const invalid = {
        tokens: [],
        aliases: [
          {
            alias: 123,
            expandsTo: "test",
            reason: null,
          },
        ],
        overrides: [],
        externalIdStableBySupplier: {},
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects alias with non-null reason that is not a string", () => {
      const invalid = {
        tokens: [],
        aliases: [
          {
            alias: "tst",
            expandsTo: "test",
            reason: 123,
          },
        ],
        overrides: [],
        externalIdStableBySupplier: {},
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe("invalid override data", () => {
    it("rejects override with invalid matchKind", () => {
      const invalid = {
        tokens: [],
        aliases: [],
        overrides: [
          {
            matchKind: "invalid_kind",
            matchValue: "test",
            baseProductKey: "base",
            productKey: "product",
            reason: "reason",
          },
        ],
        externalIdStableBySupplier: {},
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects override with non-string matchValue", () => {
      const invalid = {
        tokens: [],
        aliases: [],
        overrides: [
          {
            matchKind: "normalized_name",
            matchValue: 123,
            baseProductKey: "base",
            productKey: "product",
            reason: "reason",
          },
        ],
        externalIdStableBySupplier: {},
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects override with missing reason", () => {
      const invalid = {
        tokens: [],
        aliases: [],
        overrides: [
          {
            matchKind: "normalized_name",
            matchValue: "test",
            baseProductKey: "base",
            productKey: "product",
          },
        ],
        externalIdStableBySupplier: {},
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe("schema provides clear error messages", () => {
    it("error for missing field identifies the field", () => {
      const invalid = {
        tokens: [],
        aliases: [],
        overrides: [],
        revision: "v1",
        // missing externalIdStableBySupplier
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMessage = result.error.toString();
        expect(errorMessage).toContain("externalIdStableBySupplier");
      }
    });

    it("error for wrong type is clear", () => {
      const invalid = {
        tokens: "not an array",
        aliases: [],
        overrides: [],
        externalIdStableBySupplier: {},
        revision: "v1",
      };
      const result = knowledgeBaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMessage = result.error.toString();
        expect(errorMessage.toLowerCase()).toMatch(/array|expected/i);
      }
    });
  });
});
