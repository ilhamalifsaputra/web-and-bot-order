/**
 * Guard: every place that settles a paid order also starts the instant Digiflazz dispatch.
 *
 * When a payment settles into PROCESSING, `triggerDigiflazzDispatch(orderId)` (crud/digiflazz.ts) places the
 * Digiflazz request right away instead of leaving it for the 5-second recovery cron. A new payment rail or admin
 * action that settles an order but forgets the trigger still works, only slower, so no functional test would notice.
 * This guard makes the omission fail loudly.
 *
 * It scans source with the TypeScript AST (comments and prose never match). For every call to a SETTLE_FUNCTIONS
 * entry it finds the "owner" function: the nearest enclosing function that is not itself a `$transaction(...)`
 * callback. It then fails when:
 *
 *  A. The owner contains no `triggerDigiflazzDispatch(...)` call outside a `$transaction` callback that comes after
 *     the settle call. The exception is an owner whose own name is in SETTLE_FUNCTIONS: that function only settles
 *     inside a transaction it hands back, so its callers carry the obligation and are checked in turn.
 *  B. Anywhere at all, `triggerDigiflazzDispatch(...)` is called inside a `$transaction(...)` callback. The dispatch
 *     must start only after the payment transaction has committed.
 *
 * Limits: the check is by name. A settle function passed around as a value, or a trigger inside a helper that takes
 * `tx` as a parameter, is not seen. The ordering check is textual (trigger after settle, in the same owner); it does
 * not prove the trigger runs before every awaited Telegram call. The per-rail tests cover that.
 *
 * If this fails: call `triggerDigiflazzDispatch(order.id)` right after the settlement transaction resolves and before
 * any awaited Telegram/outbox work, only for a "processing" result. Add an ALLOWLIST entry only for a call site that
 * really must leave the order to the cron, and give the reason.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "..");

/** Every function that moves a paid order through settlement (and so may leave it PROCESSING). */
export const SETTLE_FUNCTIONS = new Set([
  "settlePaidOrder",
  "markPaidAndSettle",
  "completeOrderWithWalletCredit",
  "completeCartOrderWithWalletCredit",
  "settleFullyDiscountedOrder",
  "settleDiscountCoveredOrder",
  "manualMatchTx",
  "deliverPaidTokopayOrder",
  "deliverPaidPaydisiniOrder",
  "deliverPaidNowpaymentsOrder",
  "deliverPaidInternalOrder",
  "deliverPaidBybitOrder",
  "deliverPaidBybitBscOrder",
]);

const TRIGGER = "triggerDigiflazzDispatch";

/**
 * Settle call sites that intentionally omit automatic supplier dispatch.
 * Key: `<repo-relative path with forward slashes>#<owner function name>`. Value: why.
 * A stale entry (one that no longer matches a call site
 * that would otherwise fail) makes the guard fail too, so this list cannot rot.
 */
export const ALLOWLIST = new Map<string, string>([
  ["packages/db/src/crud/binance_internal.ts#deliverUnderpaidOrder",
    "Audited ADMIN_OVERRIDE retains UNDERPAID payment facts. Supplier orders require manual resolution; settlePaidOrder parks them in review and automatic Digiflazz dispatch must stay disabled."],
]);

/** Directories scanned, relative to the repo root. */
const SCAN_DIRS = ["apps", "packages", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "client", "test", "tests", "__fixtures__", ".turbo"]);

const calleeName = (call: ts.CallExpression): string | null => {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return null;
};

const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

/** A function passed straight to `<something>.$transaction(...)`. */
const isTransactionCallback = (fn: ts.Node): boolean => {
  const parent = fn.parent;
  return !!parent && ts.isCallExpression(parent) && calleeName(parent) === "$transaction" && parent.arguments.includes(fn as ts.Expression);
};

/** Nearest enclosing function that is not a `$transaction` callback, or the source file. */
const ownerOf = (node: ts.Node): ts.Node => {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (isFunctionLike(n) && !isTransactionCallback(n)) return n;
  }
  return node.getSourceFile();
};

const isInsideTransactionCallback = (node: ts.Node, stopAt?: ts.Node): boolean => {
  for (let n: ts.Node | undefined = node.parent; n && n !== stopAt; n = n.parent) {
    if (isFunctionLike(n) && isTransactionCallback(n)) return true;
  }
  return false;
};

const ownerName = (owner: ts.Node, source: ts.SourceFile): string => {
  if (ts.isSourceFile(owner)) return "<module>";
  if ((ts.isFunctionDeclaration(owner) || ts.isMethodDeclaration(owner) || ts.isFunctionExpression(owner)) && owner.name) {
    return owner.name.getText();
  }
  const p = owner.parent;
  if (p && ts.isVariableDeclaration(p)) return p.name.getText();
  if (p && ts.isPropertyAssignment(p)) return p.name.getText();
  return `<anonymous at line ${source.getLineAndCharacterOfPosition(owner.getStart()).line + 1}>`;
};

export type GuardFinding = { key: string; message: string };

/** All guard findings for one source file. `fileName` is the repo-relative path used in messages and allowlist keys. */
export function dispatchTriggerFindings(fileName: string, code: string): GuardFinding[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const settleCalls: ts.CallExpression[] = [];
  const triggerCalls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && SETTLE_FUNCTIONS.has(name)) settleCalls.push(node);
      if (name === TRIGGER) triggerCalls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const line = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const findings: GuardFinding[] = [];

  // Rule B: never inside a $transaction callback.
  for (const t of triggerCalls) {
    if (isInsideTransactionCallback(t)) {
      findings.push({
        key: `${fileName}#${ownerName(ownerOf(t), source)}`,
        message: `${fileName}:${line(t)}: ${TRIGGER} is called inside a $transaction callback — it must run only after the payment transaction commits`,
      });
    }
  }

  // Rule A: every settle call's owner triggers afterwards, outside any $transaction callback.
  for (const call of settleCalls) {
    const owner = ownerOf(call);
    const name = ownerName(owner, source);
    if (SETTLE_FUNCTIONS.has(name)) continue; // a settle wrapper: its callers are checked instead
    const ok = triggerCalls.some(
      (t) => ownerOf(t) === owner && !isInsideTransactionCallback(t, owner) && t.getStart() > call.getEnd(),
    );
    if (!ok) {
      findings.push({
        key: `${fileName}#${name}`,
        message: `${fileName}:${line(call)} in ${name}: ${calleeName(call)}(...) settles an order but ${name} never calls ${TRIGGER}(...) after it (outside the transaction)`,
      });
    }
  }
  return findings;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const repoPath = (full: string) => relative(ROOT, full).split(sep).join("/");

describe("instant Digiflazz dispatch guard (self-test on in-memory fixtures)", () => {
  const keys = (code: string) => dispatchTriggerFindings("fixture.ts", code).map((f) => f.key);

  it("fails a route that settles inside a transaction and never triggers", () => {
    const broken = `
      app.post("/approve", async (req, reply) => {
        await prisma.$transaction(async (tx) => {
          const result = await settlePaidOrder(tx, orderId, { adminId: 1 });
        });
        nudgeOutboxDispatcher();
      });`;
    expect(keys(broken)).toEqual(["fixture.ts#<anonymous at line 2>"]);
  });

  it("fails a poller that settles through a rail helper and never triggers", () => {
    const broken = `
      export async function reconcileOrder(api, order) {
        const r = await deliverPaidTokopayOrder(prisma, { orderId: order.id });
        if (r.status === "processing") await editBubbleAndClear(api, r.order);
      }`;
    expect(keys(broken)).toEqual(["fixture.ts#reconcileOrder"]);
  });

  it("fails a trigger placed inside the $transaction callback, even next to the settle call", () => {
    const broken = `
      async function approve(orderId) {
        await prisma.$transaction(async (tx) => {
          const result = await settlePaidOrder(tx, orderId, { adminId: 1 });
          if (result.kind === "processing") triggerDigiflazzDispatch(result.order.id);
        });
      }`;
    const found = keys(broken);
    // Rule B for the misplaced trigger, and rule A because no trigger runs after commit.
    expect(found).toEqual(["fixture.ts#approve", "fixture.ts#approve"]);
  });

  it("fails a trigger placed before the settlement", () => {
    const broken = `
      async function approve(orderId) {
        triggerDigiflazzDispatch(orderId);
        await prisma.$transaction((tx) => settlePaidOrder(tx, orderId, { adminId: 1 }));
      }`;
    expect(keys(broken)).toEqual(["fixture.ts#approve"]);
  });

  it("does not let one handler's trigger cover another handler's settle call in the same file", () => {
    const broken = `
      app.post("/a", async () => {
        const r = await manualMatchTx(prisma, args);
        if (r.kind === "processing") triggerDigiflazzDispatch(r.order.id);
      });
      app.post("/b", async () => {
        await prisma.$transaction((tx) => settlePaidOrder(tx, 1, { adminId: 1 }));
      });`;
    expect(keys(broken)).toEqual(["fixture.ts#<anonymous at line 6>"]);
  });

  it("passes a correctly wired call site, including a property-access callee", () => {
    const wired = `
      export async function performWalletCheckout(customer) {
        const result = await prisma.$transaction(async (tx) => db.completeCartOrderWithWalletCredit(tx, args));
        if (result.kind === "processing") triggerDigiflazzDispatch(result.order.id);
        return { orderCode: result.order.orderCode };
      }`;
    expect(keys(wired)).toEqual([]);
  });

  it("exempts a settle wrapper (its own name is a settle function), so its callers carry the obligation", () => {
    const wrapper = `
      export async function deliverPaidTokopayOrder(db, args) {
        return db.$transaction(async (tx) => settlePaidOrder(tx, args.orderId, { adminId: 0 }));
      }
      async function markPaidAndSettle(db, orderId) { return settlePaidOrder(db, orderId, { adminId: 0 }); }`;
    expect(keys(wrapper)).toEqual([]);
  });
});

describe("instant Digiflazz dispatch guard (repository scan)", () => {
  const files = SCAN_DIRS.flatMap((d) => sourceFiles(join(ROOT, d)));
  const findings = files.flatMap((full) => dispatchTriggerFindings(repoPath(full), readFileSync(full, "utf8")));

  it("scans the real settlement code (sanity: the scan is not silently empty)", () => {
    const scanned = new Set(files.map(repoPath));
    expect(scanned.has("packages/db/src/crud/orders.ts")).toBe(true);
    expect(scanned.has("apps/storefront/src/routes/checkout.ts")).toBe(true);
    expect(scanned.has("apps/order-bot/src/payments/tokopayReconcile.ts")).toBe(true);
    expect(scanned.has("apps/web-admin/src/routes/api/orders.ts")).toBe(true);
  });

  it("every settle call site triggers the instant dispatch after commit (or is allowlisted with a reason)", () => {
    const unexplained = findings.filter((f) => !ALLOWLIST.has(f.key)).map((f) => f.message);
    expect(unexplained).toEqual([]);
  });

  it("every allowlist entry is still needed and carries a reason", () => {
    const hit = new Set(findings.map((f) => f.key));
    for (const [key, reason] of ALLOWLIST) {
      expect(hit.has(key), `stale allowlist entry ${key}`).toBe(true);
      expect(reason.trim().length, `allowlist entry ${key} needs a reason`).toBeGreaterThan(20);
    }
  });
});
