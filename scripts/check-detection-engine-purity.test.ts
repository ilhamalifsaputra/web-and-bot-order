import { describe, expect, it } from "vitest";
import { checkFile } from "./check-detection-engine-purity";

// Mirrors the four real fixture tokens (packages/core/src/detection/__fixtures__/
// syntheticGameA.ts) so these tests exercise the same denylist shape the real
// script derives, without depending on filesystem state.
const BANNED_TOKENS = ["Game A", "Delta Force", "Free Fire", "PUBG"];

describe("checkFile", () => {
  it("returns no violations for a clean, pure file", () => {
    const content = `
/**
 * Pure helper. INV-1 (determinism): no Date.now()/Math.random(), no
 * localeCompare. INV-5 (engine purity): no @prisma/client, @app/db.
 * Example (see tokenize.ts): despace("pubg mobile") -> "pubgmobile".
 */
export function add(a: number, b: number): number {
  return a + b;
}
`;
    expect(checkFile(content, BANNED_TOKENS)).toEqual([]);
  });

  it("flags localeCompare used in real code", () => {
    const content = `export const sorted = ["b", "a"].sort((x, y) => x.localeCompare(y));\n`;
    const violations = checkFile(content, BANNED_TOKENS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 1, rule: "localeCompare" });
  });

  it("flags Date.now() but not new Date(x) with an argument", () => {
    const content = `export const t = Date.now();\nexport const d = new Date(1700000000000);\n`;
    const violations = checkFile(content, BANNED_TOKENS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 1, rule: "Date.now()" });
  });

  it("flags zero-argument new Date()", () => {
    const content = `export const now = new Date();\n`;
    const violations = checkFile(content, BANNED_TOKENS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 1, rule: "new Date() with no arguments" });
  });

  it("flags Math.random()", () => {
    const content = `export const r = Math.random();\n`;
    const violations = checkFile(content, BANNED_TOKENS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 1, rule: "Math.random()" });
  });

  it("flags an import from @prisma/client", () => {
    const content = `import { PrismaClient } from "@prisma/client";\n`;
    const violations = checkFile(content, BANNED_TOKENS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: 'forbidden import ("@prisma/client")' });
  });

  it("flags an import from @app/db, including subpaths", () => {
    const content = `import { getOrder } from "@app/db/crud/orders";\n`;
    const violations = checkFile(content, BANNED_TOKENS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: 'forbidden import ("@app/db")' });
  });

  it("flags a banned product name appearing in real code, case-insensitively", () => {
    const content = `export const label = "free fire event";\n`;
    const violations = checkFile(content, BANNED_TOKENS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: 'product-specific name ("Free Fire")' });
  });

  it("does NOT flag a banned product name that appears only in a comment", () => {
    const content = `// Example: "PUBG Mobile" is a well-known battle royale game.\nexport const noop = 1;\n`;
    expect(checkFile(content, BANNED_TOKENS)).toEqual([]);
  });

  it("does NOT flag Date.now()/Math.random()/localeCompare mentioned only in a doc comment", () => {
    const content = `/**\n * INV-1: no Date.now()/Math.random(), no localeCompare.\n */\nexport const ok = 1;\n`;
    expect(checkFile(content, BANNED_TOKENS)).toEqual([]);
  });

  it("reports multiple violations across multiple lines with correct line numbers", () => {
    const content = [
      `export const a = Math.random();`,
      `export const b = "Delta Force Edition";`,
      `export const c = 1;`,
    ].join("\n");
    const violations = checkFile(content, BANNED_TOKENS);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 1, rule: "Math.random()" }),
        expect.objectContaining({ line: 2, rule: 'product-specific name ("Delta Force")' }),
      ]),
    );
    expect(violations.every((v) => v.line !== 3)).toBe(true);
  });
});
