/**
 * Anti-regression guard: whether a SKU draws from local stock (and so can be
 * "out of stock") is decided only by @app/core/productAvailability
 * (`fulfillmentSourceOf`, `usesLocalInventory`, `hasSellableStock`,
 * `resolveDenominationAvailability`), the same rule the order server applies.
 *
 * The bot and the storefront once re-derived it inline as
 * `deliveryType !== "auto"`, which ignores `autoDeliverySource`: an
 * `auto` + `digiflazz` SKU then showed "Out of stock" / "Notify me" while the
 * server accepted the order. This scans apps/order-bot/src, apps/storefront/src
 * and apps/storefront/client/src with the TypeScript AST (comments and prose
 * never match) and fails on:
 *
 *  1. a comparison (=== !== == !=) of a deliveryType / delivery_type value with
 *     "auto" or DeliveryType.AUTO;
 *  2. any other DeliveryType.AUTO reference — the "auto means local stock"
 *     rule lives in core, not in an app.
 *
 * The storefront client cannot import @app/core: it reads the server's
 * `purchasable` / `uses_local_inventory` / `all_local_inventory` fields.
 *
 * If this fails, call the resolver (server/bot) or read the server field
 * (client). Add to ALLOWLIST only for code that WRITES or MAPS a deliveryType
 * value (e.g. an import/admin form), never one that decides eligibility or
 * stock, and say why.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const SCANNED_DIRS = [
  join(ROOT, "apps", "order-bot", "src"),
  join(ROOT, "apps", "storefront", "src"),
  join(ROOT, "apps", "storefront", "client", "src"),
];

/** repo-relative path (forward slashes) → why it may mention the token. Empty today. */
const ALLOWLIST: Record<string, string> = {};

const DELIVERY_NAME = /^(deliveryType|delivery_type)$/;

/** The identifier or property name an expression ends in (`d.deliveryType` → "deliveryType"). */
function tailName(expr: ts.Expression): string | null {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteral(e.argumentExpression)) return e.argumentExpression.text;
  return null;
}

function isDeliveryTypeAuto(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === "AUTO" && ts.isIdentifier(node.expression) && node.expression.text === "DeliveryType";
}

function isAutoValue(expr: ts.Expression): boolean {
  return (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) ? expr.text === "auto" : isDeliveryTypeAuto(expr);
}

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** Every inline "is this an auto (local-stock) SKU" decision in one source file. */
export function availabilityViolations(fileName: string, code: string): string[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const reported = new Set<ts.Node>();
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
      const pairs: Array<[ts.Expression, ts.Expression]> = [[node.left, node.right], [node.right, node.left]];
      for (const [a, b] of pairs) {
        const name = tailName(a);
        if (name && DELIVERY_NAME.test(name) && isAutoValue(b)) {
          found.push(`${fileName}:${line(node)}: ${node.getText()} — use usesLocalInventory/hasSellableStock (server, bot) or the server's purchasable/uses_local_inventory field (client)`);
          reported.add(b);
          break;
        }
      }
    } else if (isDeliveryTypeAuto(node) && !reported.has(node)) {
      found.push(`${fileName}:${line(node)}: DeliveryType.AUTO — the local-stock rule lives in @app/core/productAvailability`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("availability guard (synthetic fixtures)", () => {
  it.each([
    ['const ok = d.deliveryType !== "auto" || stock > 0;', "!== \"auto\""],
    ['if (product.deliveryType === "auto") {}', "=== \"auto\""],
    ["const m = denom.deliveryType === DeliveryType.AUTO ? stock : 99;", "=== DeliveryType.AUTO"],
    ['const b = "auto" == d.delivery_type;', "reversed =="],
    ["const b = (d!.deliveryType as string) != DeliveryType.AUTO;", "wrapped !="],
    ["const isAuto = deliveryType === `auto`;", "bare identifier, template literal"],
    ['const show = item.delivery_type === "auto" && item.qty > item.available;', "client field"],
    ["const kinds = [DeliveryType.AUTO];", "bare DeliveryType.AUTO"],
  ])("flags %s (%s)", (code) => {
    expect(availabilityViolations("fixture.ts", code)).toHaveLength(1);
  });

  it.each([
    "const ok = hasSellableStock(d, stock);",
    "const local = usesLocalInventory(d);",
    'const manual = d.deliveryType === DeliveryType.MANUAL_WITH_INFO || d.deliveryType === "manual";',
    'const created = { deliveryType: "auto" };',
    'const mode = scrollRestoration === "auto";',
    '// d.deliveryType !== "auto" in a comment',
    'const doc = "deliveryType !== \\"auto\\"";',
  ])("allows %s", (code) => {
    expect(availabilityViolations("fixture.ts", code)).toEqual([]);
  });

  it("parses TSX", () => {
    expect(availabilityViolations("fixture.tsx", 'const x = <div>{d.delivery_type === "auto" ? 1 : 2}</div>;')).toHaveLength(1);
  });
});

describe("availability guard (repository)", () => {
  it("no bot or storefront file decides local stock inline", () => {
    const violations: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of sourceFiles(dir)) {
        const rel = relative(ROOT, file).split(sep).join("/");
        if (ALLOWLIST[rel]) continue;
        violations.push(...availabilityViolations(rel, readFileSync(file, "utf8")));
      }
    }
    expect(violations).toEqual([]);
  });

  it("every allowlist entry still exists and gives a reason", () => {
    for (const [rel, why] of Object.entries(ALLOWLIST)) {
      expect(why.trim().length, rel).toBeGreaterThan(10);
      expect(() => readFileSync(join(ROOT, rel)), rel).not.toThrow();
    }
  });
});
