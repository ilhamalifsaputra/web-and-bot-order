/**
 * Guard for buyer answers (`Order.customerData`) stored encrypted at rest. The
 * readers that turn the stored string into answers (parseCustomerData,
 * buildDigiflazzCustomerNo, orderGameTargets) must be handed PLAINTEXT. An
 * order read through getOrder / getOrderByCodeFull / getOrderByCodeFullForDisplay
 * is already decrypted; a raw row (getOrderRaw, getOrderByCode — which is RAW
 * despite its name —, a bare findUnique/findMany, a `select`) is ciphertext
 * and must go through decryptCustomerData / tryDecryptCustomerData first.
 *
 * It scans source with the TypeScript AST and fails when one of those readers
 * is called with a bare `<something>.customerData` outside an allow-listed
 * file. Add a file to ALLOWED_DECRYPTED_SOURCES only after confirming its
 * order comes from a decrypting reader, and say which one. Decrypting twice is
 * also a bug (it throws when ALLOW_LEGACY_PLAINTEXT=false), so do not wrap a
 * value that is already plaintext.
 *
 * A second, coarser rule lists every non-test source file that reads
 * `.customerData` off anything but a bot `scratch` object (READER_FILES). A new
 * file that starts reading the column fails until someone has checked whether
 * its row is decrypted and added it with a reason. It catches readers the first
 * rule cannot see (a value passed on, aliased or rendered directly); it does not
 * see a destructured `{ customerData }`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

/** Answer readers whose customer-data argument must be plaintext, and its argument index. */
const READERS: Record<string, number> = {
  parseCustomerData: 0,
  buildDigiflazzCustomerNo: 1,
  orderGameTargets: 2,
};

/** Files whose `order` is read through a decrypting reader (the choke points in packages/db/src/crud/orders.ts). */
const ALLOWED_DECRYPTED_SOURCES: Record<string, string> = {
  "apps/web-admin/src/routes/api/orders.ts": "admin order detail reads through getOrder",
  "apps/storefront/src/routes/apiAccount.ts": "buyer order page reads through getOrderByCodeFullForDisplay",
  "apps/storefront/src/routes/gameTopupDetails.ts": "callers pass an already decrypted order (see apiCheckout.ts)",
  "apps/order-bot/src/handlers/customer.ts": "bot order detail reads through getOrder",
  "apps/order-bot/src/conversations/editCustomerInfo.ts": "the edit flow reads through getOrder",
};

/** Every non-test source file that reads `<x>.customerData` (x not a bot `scratch`), and why its value is safe. */
const READER_FILES: Record<string, string> = {
  "apps/order-bot/src/conversations/editCustomerInfo.ts": "order from getOrder (decrypted)",
  "apps/order-bot/src/handlers/checkout.ts": "args.customerData is the buyer's new answers passed into createOrderDirect, which encrypts them",
  "apps/order-bot/src/handlers/customer.ts": "order from getOrder (decrypted)",
  "apps/storefront/src/routes/apiAccount.ts": "order from getOrderByCodeFullForDisplay (decrypted)",
  "apps/storefront/src/routes/apiCheckout.ts": "raw getOrderByCode row, decrypted with tryDecryptCustomerData before use",
  "apps/storefront/src/routes/checkout.ts": "raw webhook row, decrypted with decryptCustomerData before use",
  "apps/storefront/src/routes/gameTopupDetails.ts": "callers pass an already decrypted order",
  "apps/web-admin/src/routes/api/orders.ts": "order from getOrder (decrypted)",
  "packages/db/src/crud/digiflazz.ts": "raw rows, each decrypted with decryptCustomerData before use",
  "packages/db/src/crud/orders.ts": "the decrypting choke points themselves, plus args.customerData (new answers to encrypt)",
  "packages/db/src/crud/wallet_checkout.ts": "args.customerData is the buyer's new answers, passed on to the order writers",
  "packages/outbox-dispatcher/src/fulfillmentMessages.ts": "raw row, decrypted with tryDecryptCustomerData before use",
};

/** Lines of `code` that read `<x>.customerData` where x is not a bot `scratch` object (object-literal keys are not reads). */
export function customerDataReads(fileName: string, code: string): number[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "customerData" && !/(^|\.)scratch$/.test(node.expression.getText())) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

const isSource = (p: string) => /\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p) && !p.includes(`${sep}client${sep}`) && !p.includes("node_modules");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === "static") continue;
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (isSource(full)) yield full;
  }
}

const calleeName = (call: ts.CallExpression): string | null => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
};

/** `x.customerData` where the receiver is not a bot `scratch` object. */
const isBareCustomerDataAccess = (expr: ts.Expression): boolean => {
  // `x.customerData!`, `(x.customerData)`, `x.customerData as string` and the like are still the raw column.
  let e = expr;
  while (
    ts.isNonNullExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }
  if (!ts.isPropertyAccessExpression(e) || e.name.text !== "customerData") return false;
  const receiver = e.expression.getText();
  return !/(^|\.)scratch$/.test(receiver);
};

/** Violations in one file's source text (exported shape so the self-test can use it). */
export function customerDataViolations(fileName: string, code: string): string[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && name in READERS) {
        const arg = node.arguments[READERS[name]!];
        if (arg && isBareCustomerDataAccess(arg)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          found.push(`${fileName}:${line}: ${name}(${arg.getText()}) reads a possibly encrypted column — decrypt it with decryptCustomerData / tryDecryptCustomerData, or read the order through getOrder`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("customer-data guard", () => {
  it("flags a reader handed a bare order.customerData", () => {
    const bad = `import { parseCustomerData } from "@app/core/deliveryFields"; const a = parseCustomerData(order.customerData);`;
    expect(customerDataViolations("x.ts", bad)).toHaveLength(1);
    const bad2 = `const n = buildDigiflazzCustomerNo(product, row.customerData, snapshot);`;
    expect(customerDataViolations("x.ts", bad2)).toHaveLength(1);
    const bad3 = `const t = orderGameTargets(product, snapshot, order.customerData);`;
    expect(customerDataViolations("x.ts", bad3)).toHaveLength(1);
    const castAway = `parseCustomerData((order.customerData as string)!);`;
    expect(customerDataViolations("x.ts", castAway)).toHaveLength(1);
  });

  it("accepts a decrypted argument and a bot scratch string", () => {
    expect(customerDataViolations("x.ts", `parseCustomerData(decryptCustomerData(order.customerData, order.id));`)).toEqual([]);
    expect(customerDataViolations("x.ts", `orderGameTargets(p, s, tryDecryptCustomerData(order.customerData, { orderId: 1, purpose: "x" }));`)).toEqual([]);
    expect(customerDataViolations("x.ts", `parseCustomerData(ctx.session.scratch.customerData);`)).toEqual([]);
  });

  it("no source file passes a possibly encrypted customerData to an answer reader", () => {
    const violations: string[] = [];
    for (const top of ["apps", "packages"]) {
      for (const file of walk(join(ROOT, top))) {
        const rel = relative(ROOT, file).split(sep).join("/");
        if (rel in ALLOWED_DECRYPTED_SOURCES) continue;
        violations.push(...customerDataViolations(rel, readFileSync(file, "utf8")));
      }
    }
    expect(violations).toEqual([]);
  });

  it("customerDataReads sees a property read but not an object-literal key or a bot scratch value", () => {
    expect(customerDataReads("x.ts", `const a = order.customerData;
const b = row!.customerData;`)).toEqual([1, 2]);
    expect(customerDataReads("x.ts", `db.order.create({ data: { customerData: null } });`)).toEqual([]);
    expect(customerDataReads("x.ts", `const s = ctx.session.scratch.customerData;`)).toEqual([]);
  });

  it("only reviewed files read customerData off an order (a new reader file must be checked and listed)", () => {
    const unreviewed: string[] = [];
    const listedButSilent: string[] = [];
    for (const top of ["apps", "packages"]) {
      for (const file of walk(join(ROOT, top))) {
        const rel = relative(ROOT, file).split(sep).join("/");
        const reads = customerDataReads(rel, readFileSync(file, "utf8"));
        if (reads.length > 0 && !(rel in READER_FILES)) unreviewed.push(`${rel}:${reads.join(",")}`);
        if (reads.length === 0 && rel in READER_FILES) listedButSilent.push(rel);
      }
    }
    expect(unreviewed).toEqual([]);
    // A listed file that no longer reads the column is a stale entry: remove it.
    expect(listedButSilent).toEqual([]);
  });

  it("every allow-listed file still exists (a stale entry hides a real violation)", () => {
    for (const rel of [...Object.keys(ALLOWED_DECRYPTED_SOURCES), ...Object.keys(READER_FILES)]) {
      expect(() => statSync(join(ROOT, rel))).not.toThrow();
    }
  });
});
