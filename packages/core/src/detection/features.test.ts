import { describe, it, expect } from "vitest";
import { extractFeatures } from "./features";
import { normalize } from "./normalize";
import type { KnowledgeBase } from "./types";

// Small, self-contained knowledge base for these tests — deliberately not
// the real DEFAULT_KNOWLEDGE_BASE, so each test's expectations don't drift
// if the default vocabulary changes. No real product names: generic
// category words plus an invented three-letter alias.
const TEST_KNOWLEDGE: KnowledgeBase = {
  tokens: [
    { category: "platform", token: "mobile", canonical: "mobile", isProductDefining: true, enabled: true },
    { category: "platform", token: "pc", canonical: "pc", isProductDefining: true, enabled: true },
    { category: "edition", token: "pro", canonical: "pro", isProductDefining: true, enabled: true },
    { category: "distribution", token: "zeta", canonical: "zeta", isProductDefining: true, enabled: true },
    { category: "region", token: "id", canonical: "id", isProductDefining: false, enabled: true },
    { category: "region", token: "indonesia", canonical: "id", isProductDefining: false, enabled: true },
    { category: "noise", token: "instant", canonical: "instant", isProductDefining: false, enabled: true },
    { category: "noise", token: "proses cepat", canonical: "proses cepat", isProductDefining: false, enabled: true },
    // Disabled token: must never classify, even though it matches by string.
    { category: "edition", token: "beta", canonical: "beta", isProductDefining: true, enabled: false },
  ],
  aliases: [{ alias: "abc", expandsTo: "alpha beta charlie", reason: "invented test alias" }],
  overrides: [],
  externalIdStableBySupplier: {},
  revision: "test",
};

describe("extractFeatures", () => {
  it("expands a full-name alias before tokenizing", () => {
    const result = extractFeatures("abc", TEST_KNOWLEDGE);
    expect(result.coreTokens).toEqual(["alpha", "beta", "charlie"]);
  });

  it("expands an alias matched via the despaced form", () => {
    // "a b c" despaces to "abc", which matches the alias key.
    const result = extractFeatures("a b c", TEST_KNOWLEDGE);
    expect(result.coreTokens).toEqual(["alpha", "beta", "charlie"]);
  });

  it("does not expand when the name only partially matches an alias", () => {
    const result = extractFeatures("abc plus", TEST_KNOWLEDGE);
    expect(result.coreTokens).toEqual(["abc", "plus"]);
  });

  it("classifies a platform token as defining, stripping it from coreTokens", () => {
    const result = extractFeatures("legends mobile", TEST_KNOWLEDGE);
    expect(result.coreTokens).toEqual(["legends"]);
    expect(result.definingTokens).toEqual([{ category: "platform", canonical: "mobile" }]);
    expect(result.distributionTokens).toEqual([]);
  });

  it("classifies an edition token as defining", () => {
    const result = extractFeatures("legends pro", TEST_KNOWLEDGE);
    expect(result.coreTokens).toEqual(["legends"]);
    expect(result.definingTokens).toEqual([{ category: "edition", canonical: "pro" }]);
  });

  it("classifies a distribution-category token as defining (per isProductDefining, not category name)", () => {
    const result = extractFeatures("legends zeta", TEST_KNOWLEDGE);
    expect(result.coreTokens).toEqual(["legends"]);
    expect(result.definingTokens).toEqual([{ category: "distribution", canonical: "zeta" }]);
    expect(result.distributionTokens).toEqual([]);
  });

  it("classifies a non-defining region token as a distribution token", () => {
    const result = extractFeatures("legends id", TEST_KNOWLEDGE);
    expect(result.coreTokens).toEqual(["legends"]);
    expect(result.distributionTokens).toEqual([{ category: "region", canonical: "id" }]);
    expect(result.definingTokens).toEqual([]);
  });

  it("drops a noise token entirely from coreTokens", () => {
    const result = extractFeatures("legends instant", TEST_KNOWLEDGE);
    expect(result.coreTokens).toEqual(["legends"]);
    expect(result.definingTokens).toEqual([]);
    expect(result.distributionTokens).toEqual([]);
  });

  it("never classifies a disabled token, even on an exact string match", () => {
    const result = extractFeatures("legends beta", TEST_KNOWLEDGE);
    expect(result.coreTokens).toEqual(["legends", "beta"]);
    expect(result.definingTokens).toEqual([]);
  });

  it("has no parentheticalSuffix when there is no trailing parenthetical", () => {
    const result = extractFeatures("legends mobile", TEST_KNOWLEDGE);
    expect(result.parentheticalSuffix).toBeNull();
  });

  it("extracts a region parenthetical as parentheticalSuffix and classifies it", () => {
    const result = extractFeatures("legends (indonesia)", TEST_KNOWLEDGE);
    expect(result.parentheticalSuffix).toBe("indonesia");
    expect(result.coreTokens).toEqual(["legends"]);
    expect(result.distributionTokens).toEqual([{ category: "region", canonical: "id" }]);
  });

  it("suppresses a denylisted-noise parenthetical to null", () => {
    const result = extractFeatures("legends (instant)", TEST_KNOWLEDGE);
    expect(result.parentheticalSuffix).toBeNull();
    expect(result.coreTokens).toEqual(["legends"]);
  });

  it("suppresses a multi-word denylisted-noise parenthetical to null", () => {
    const result = extractFeatures("legends (proses cepat)", TEST_KNOWLEDGE);
    expect(result.parentheticalSuffix).toBeNull();
    expect(result.coreTokens).toEqual(["legends"]);
  });

  it("suppresses a duration-range parenthetical to null (through the real normalize() -> extractFeatures() pipeline)", () => {
    // Raw input has the literal hyphen a real Digiflazz product name would
    // carry; normalize() collapses "1-3" to "1 3" before extractFeatures
    // ever sees it, which is the shape DURATION_RANGE_PATTERN must match.
    const result = extractFeatures(normalize("Legends (1-3 Menit)"), TEST_KNOWLEDGE);
    expect(result.parentheticalSuffix).toBeNull();
    expect(result.coreTokens).toEqual(["legends"]);
  });

  it("suppresses duration-range parentheticals for jam and hari units too (through normalize())", () => {
    expect(extractFeatures(normalize("Legends (2-5 Jam)"), TEST_KNOWLEDGE).parentheticalSuffix).toBeNull();
    expect(extractFeatures(normalize("Legends (1-2 Hari)"), TEST_KNOWLEDGE).parentheticalSuffix).toBeNull();
  });

  it("does not suppress a single-count duration-like parenthetical (no range dash)", () => {
    // "2 jam" has no "N N" shape, so the duration-range pattern must not match.
    const result = extractFeatures(normalize("Legends (2 Jam)"), TEST_KNOWLEDGE);
    expect(result.parentheticalSuffix).toBe("2 jam");
  });

  it("end-to-end regression: a genuine raw Digiflazz-style duration-range name is denylisted, not misread as a real annotation", () => {
    // This is the exact shape Task 13's cutover fed through the pipeline
    // that caught the bug: DURATION_RANGE_PATTERN previously required a
    // literal hyphen, but normalize() always removes it before
    // extractFeatures runs, so the denylist never actually fired.
    const result = extractFeatures(normalize("Some Product (1-3 Menit)"), TEST_KNOWLEDGE);
    expect(result.parentheticalSuffix).toBeNull();
  });

  it("suppresses a duration-range parenthetical with no space before the unit word (review fix regression)", () => {
    // Digiflazz product names are free text: "1-3Menit" (unit glued to the
    // second number, no space) is a realistic variant, not hypothetical.
    // normalize() collapses the hyphen to a space but does nothing to insert
    // a space before "menit", so this arrives here as "1 3menit". The old
    // (pre-fix) DURATION_RANGE_PATTERN required a mandatory space before the
    // unit and missed this case, letting a spurious "Foo (1-3Menit)" region
    // split slip through. See features.ts's DURATION_RANGE_PATTERN comment.
    const result = extractFeatures(normalize("Foo (1-3Menit)"), TEST_KNOWLEDGE);
    expect(result.parentheticalSuffix).toBeNull();
  });

  it("does not leak a literal paren character into coreTokens", () => {
    const result = extractFeatures("legends (unknown suffix)", TEST_KNOWLEDGE);
    expect(result.coreTokens).toEqual(["legends"]);
    expect(result.coreTokens.join(" ")).not.toContain("(");
    expect(result.parentheticalSuffix).toBe("unknown suffix");
  });

  it("keeps an unclassified parenthetical word out of definingTokens/distributionTokens but preserves it in parentheticalSuffix", () => {
    const result = extractFeatures("legends (unknown suffix)", TEST_KNOWLEDGE);
    expect(result.definingTokens).toEqual([]);
    expect(result.distributionTokens).toEqual([]);
    expect(result.parentheticalSuffix).toBe("unknown suffix");
  });
});
