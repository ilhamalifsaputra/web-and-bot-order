/**
 * Price lock (Game Top-up Phase 3, Task 2): every bot pay handler charges only
 * the IDR total its payment screen recorded in `scratch.quotedTotalIdr`, and a
 * tap with no recorded quote re-renders the screen instead of paying. A test
 * that drives a pay handler directly, without rendering that screen first,
 * calls this to record the quote the screen would have shown — through the
 * same `quoteConfirmation` the renders use, so it can never quote a figure the
 * real screen would not.
 *
 * Runs on a throwaway context that shares the session, so nothing it does
 * lands in the test's own call sink.
 */
import type { MyContext } from "../../src/context";
import { quoteConfirmation } from "../../src/handlers/checkout";
import { currentUsdtRate } from "../../src/util/rate";
import { makeCtx } from "./ctx";

export async function primeQuote(ctx: MyContext, productId: number, quantity: number): Promise<void> {
  const { ctx: screen } = makeCtx({ sharedSession: ctx.session, from: ctx.from ? { id: ctx.from.id } : undefined });
  await quoteConfirmation(screen, productId, quantity, await currentUsdtRate());
}
