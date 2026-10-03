/**
 * The enforcing guard for money INPUT and DISPLAY (see the "Money" rules in .claude/CLAUDE.md). It scans source with
 * the TypeScript AST (comments and prose never match) and fails when:
 *
 *  A. Typed text is read as an amount without the shared reader. A buyer or admin types `10.000` meaning ten thousand;
 *     `new Decimal("10.000")`, `parseFloat`, `Number(text)` or `.replace(",", ".")` read it as 10. Typed amounts go
 *     through `parseMoneyInput` / `normalizeMoneyInput` (packages/core/src/moneyFormat.ts, moneyInput.ts), a typed
 *     percent through `parsePercentInput`.
 *  B. A buyer-facing bot file formats money by hand or without the buyer's language: `formatIdr(...)` (the language-less
 *     Rupiah form), `toLocaleString`, `Intl.NumberFormat`, or an `Rp` literal. Buyer screens use formatIdrFor /
 *     ctxPriceFormatter / orderAmount (packages/core/src/moneyFormat.ts, apps/order-bot/src/util/format.ts).
 *  C. The storefront top-up form judges its amount with `Number(amount)` instead of the shared reader.
 *  D. An admin-panel API route builds a Decimal straight from its request body instead of going through
 *     apps/web-admin/src/lib/moneyField.ts (by shape for typed text; exact dot-decimal for `exact_fields` pre-fills).
 *
 * Admin-facing bot screens deliberately keep the Indonesian `formatIdr` (see ADMIN_FACING). If this fails, use the
 * shared helper; add to an allowlist only for a value that is NOT typed money (a percent, an id) and say why.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const BOT_SRC = join(ROOT, "apps", "order-bot", "src");

/** Names that hold text a person typed (or a cell of an imported file). */
const TYPED_NAMES = new Set(["raw", "rawText", "text", "typed", "input", "valStr", "price", "costPrice", "resellerPrice", "amountText"]);
/** Enclosing functions that legitimately normalize a typed value that is not money. */
const ALLOWED_FUNCTIONS = new Set(["parsePercentInput"]);
/** Bot files that only admins read: they keep the Indonesian language-less `formatIdr`. */
const ADMIN_FACING = new Set(["admin.ts", "verification.ts", "reject.ts", "adminMenu.ts"]);

const enclosingFunction = (node: ts.Node): string => {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
    if (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n.name.getText();
  }
  return "<module>";
};

const isTypedText = (expr: ts.Expression): boolean => {
  const e = ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  if (ts.isIdentifier(e)) return TYPED_NAMES.has(e.text);
  if (ts.isElementAccessExpression(e)) return ts.isIdentifier(e.expression) && e.expression.text === "args";
  if (ts.isPropertyAccessExpression(e)) return e.name.text === "text" || e.name.text === "match";
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "trim") return isTypedText(e.expression.expression);
  return false;
};

/** Rule A: every place that reads typed text as an amount without the shared reader. */
export function typedMoneyViolations(fileName: string, code: string): string[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const where = () => `${fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} in ${enclosingFunction(node)}`;
    if (ts.isNewExpression(node) && node.expression.getText() === "Decimal" && node.arguments?.length && isTypedText(node.arguments[0]!)) {
      if (!ALLOWED_FUNCTIONS.has(enclosingFunction(node))) found.push(`${where()}: new Decimal(<typed text>) — use parseMoneyInput`);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "parseFloat") found.push(`${where()}: parseFloat on typed text — use parseMoneyInput`);
      if (ts.isIdentifier(callee) && callee.text === "Number" && node.arguments.length === 1 && isTypedText(node.arguments[0]!)) {
        found.push(`${where()}: Number(<typed text>) — use parseMoneyInput / normalizeMoneyInput`);
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "replace") {
        const first = node.arguments[0];
        const comma = first && ((ts.isStringLiteral(first) && first.text === ",") || (ts.isRegularExpressionLiteral(first) && /^\/,\/[a-z]*$/.test(first.text)));
        if (comma && !ALLOWED_FUNCTIONS.has(enclosingFunction(node))) found.push(`${where()}: .replace(",", ...) on an amount — use parseMoneyInput`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Rule B: hand-formatted or language-less money in a buyer-facing file. */
export function buyerDisplayViolations(fileName: string, code: string): string[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const at = `${fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "formatIdr") found.push(`${at}: formatIdr(...) has no buyer language — use formatIdrFor / ctxPriceFormatter / orderAmount`);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "toLocaleString") found.push(`${at}: toLocaleString on a buyer screen — use the money formatters`);
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "Intl" && node.name.text === "NumberFormat") found.push(`${at}: Intl.NumberFormat on a buyer screen — use the money formatters`);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (/Rp(?![A-Za-z])/.test(node.text)) found.push(`${at}: "${node.text.slice(0, 40)}" spells an Rp amount by hand — use formatIdrFor`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Rule C: the storefront top-up form must read its amount with the shared reader. */
export function storefrontAmountViolations(fileName: string, code: string): string[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const at = `${fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Number" && node.arguments.length === 1) {
      const arg = node.arguments[0]!;
      if (ts.isIdentifier(arg) && arg.text === "amount") found.push(`${at}: Number(amount) reads 10.000 as 10 — use normalizeMoneyInput`);
    }
    if (ts.isJsxAttribute(node) && node.name.getText() === "type" && node.initializer && ts.isStringLiteral(node.initializer) && node.initializer.text === "number") {
      const element = node.parent.parent;
      if (/topup_amount/.test(element.getText())) found.push(`${at}: the amount input must be type="text" so a typed 10.000 reaches normalizeMoneyInput`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Rule D: an admin-panel route never builds a Decimal straight from its request body
 * (`new Decimal(body.price)`, `new Decimal(String(body.value).trim())`) — typed amounts go
 * through apps/web-admin/src/lib/moneyField.ts (readMoneyField / readPercentField), which read by shape — or, for a
 * machine-formatted value the client lists in `exact_fields` (an untouched pre-fill of the server's own decimal), as a
 * plain dot-decimal via their `exact` option. Both paths live in that helper, so this rule never blocks either.
 */
export function adminBodyDecimalViolations(fileName: string, code: string): string[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const mentionsBody = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && node.text === "body") || ts.forEachChild(node, mentionsBody) === true;
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && node.expression.getText() === "Decimal" && node.arguments?.length && mentionsBody(node.arguments[0]!)) {
      found.push(`${fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: new Decimal(<request body>) — use readMoneyField / readPercentField`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const tsFiles = (...dir: string[]) =>
  readdirSync(join(...dir)).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts")).map((file) => join(...dir, file));
const rel = (file: string) => file.slice(ROOT.length + 1).replaceAll("\\", "/");
const scan = (files: string[], rule: (name: string, code: string) => string[]) => files.flatMap((file) => rule(rel(file), readFileSync(file, "utf8")));

describe("money input and display guard", () => {
  it("detects the shapes it exists to catch (the guard itself is not vacuous)", () => {
    const bad = [
      'const a = new Decimal(args[1]!);',
      'const b = new Decimal(raw.replace(",", "."));',
      'const c = parseFloat(text);',
      'const d = Number(valStr);',
      'const e = new Decimal(u.message.text.trim());',
      'const f = raw.replace(/,/g, "");',
    ];
    for (const code of bad) expect(typedMoneyViolations("x.ts", code), code).not.toEqual([]);
    expect(typedMoneyViolations("x.ts", 'function parsePercentInput(raw: string) { return new Decimal(raw.replace(",", ".")); }')).toEqual([]);
    expect(typedMoneyViolations("x.ts", "const g = new Decimal(row.price); const h = Number(row.quantity); const i = new Decimal('5');")).toEqual([]);
    for (const code of ["formatIdr(x)", "n.toLocaleString()", "new Intl.NumberFormat('id')", 'const s = `Rp${n}`;', 'const s = "Rp 1";']) {
      expect(buyerDisplayViolations("x.ts", code), code).not.toEqual([]);
    }
    expect(buyerDisplayViolations("x.ts", 'const s = formatIdrFor(n, lang); // Rp10.000 in a comment\nconst r = "Rpm";')).toEqual([]);
    expect(storefrontAmountViolations("x.tsx", "const n = Number(amount);")).not.toEqual([]);
    expect(storefrontAmountViolations("x.tsx", '<Input id="topup_amount" type="number" />')).not.toEqual([]);
    expect(storefrontAmountViolations("x.tsx", '<Input id="topup_amount" type="text" /> /* Number(parsed) */')).toEqual([]);
    for (const code of ["new Decimal(body.price);", 'new Decimal(String(body.value).trim());', 'new Decimal((body.delta ?? "").trim());']) {
      expect(adminBodyDecimalViolations("x.ts", code), code).not.toEqual([]);
    }
    expect(adminBodyDecimalViolations("x.ts", "new Decimal(0); new Decimal(row.revenue_idr); readMoneyField(body.price);")).toEqual([]);
    // The machine path — a pre-filled value the client lists in `exact_fields` — is read as a plain dot-decimal
    // through the same helper, never by a route's own `new Decimal`.
    expect(adminBodyDecimalViolations("x.ts", 'readMoneyField(body.price, "IDR", { exact: exactFields(body).has("price") });')).toEqual([]);
  });

  it("D: admin-panel routes never build a Decimal straight from the request body", () => {
    const files = tsFiles(ROOT, "apps", "web-admin", "src", "routes", "api");
    expect(files.length).toBeGreaterThan(10);
    const hits = scan(files, adminBodyDecimalViolations);
    expect(hits, `Typed money in admin routes goes through readMoneyField / readPercentField:\n${hits.join("\n")}`).toEqual([]);
  });

  it("A: no admin or buyer conversation, handler, or the catalog import reads typed text as an amount by hand", () => {
    const files = [
      ...tsFiles(BOT_SRC, "conversations"),
      ...tsFiles(BOT_SRC, "handlers"),
      join(ROOT, "apps", "web-admin", "src", "lib", "catalogImport.ts"),
    ];
    expect(files.length).toBeGreaterThan(10);
    const hits = scan(files, typedMoneyViolations);
    expect(hits, `Typed money must go through parseMoneyInput / normalizeMoneyInput (a typed percent through parsePercentInput):\n${hits.join("\n")}`).toEqual([]);
  });

  it("B: buyer-facing bot files never format money by hand or without the buyer's language", () => {
    const files = ["handlers", "conversations", "keyboards"]
      .flatMap((dir) => tsFiles(BOT_SRC, dir))
      .filter((file) => !ADMIN_FACING.has(file.split(/[\\/]/).at(-1)!) && !/[\\/]keyboards[\\/]admin/.test(file));
    expect(files.length).toBeGreaterThan(10);
    const hits = scan(files, buyerDisplayViolations);
    expect(hits, `Buyer screens format money only through formatIdrFor / ctxPriceFormatter / orderAmount:\n${hits.join("\n")}`).toEqual([]);
  });

  it("C: the storefront top-up form reads its amount with the shared reader", () => {
    const file = join(ROOT, "apps", "storefront", "client", "src", "pages", "WalletTopupPage.tsx");
    const hits = storefrontAmountViolations(rel(file), readFileSync(file, "utf8"));
    expect(hits, hits.join("\n")).toEqual([]);
  });
});
