/**
 * Price lock (Game Top-up Phase 3, Task 2): every bot pay handler charges only
 * the IDR total its payment screen recorded in `scratch.quotedTotalIdr`, and
 * only for a tap carrying that render's nonce (`scratch.quoteNonce`, the pay
 * callback's last segment). A tap with no recorded quote, or from an older
 * render, re-renders the screen instead of paying. A test that drives a pay
 * handler directly, without rendering that screen first, calls this to record
 * the quote the screen would have shown — through the same `quoteConfirmation`
 * the renders use, so it can never quote a figure the real screen would not —
 * and passes the returned nonce to the handler, as the screen's button would.
 *
 * Runs on a throwaway context that shares the session, so nothing it does
 * lands in the test's own call sink.
 */
import type { MyContext } from "../../src/context";
import { quoteConfirmation } from "../../src/handlers/checkout";
import { currentUsdtRate } from "../../src/util/rate";
import { makeCtx } from "./ctx";

export async function primeQuote(ctx: MyContext, productId: number, quantity: number): Promise<string | undefined> {
  const { ctx: screen } = makeCtx({ sharedSession: ctx.session, from: ctx.from ? { id: ctx.from.id } : undefined });
  const r = await quoteConfirmation(screen, productId, quantity, await currentUsdtRate());
  return r?.nonce;
}

/** The nonce of the payment screen the session last rendered: what a tap on
 *  that screen's pay button carries. */
export function quoteNonce(ctx: MyContext): string | undefined {
  const n = ctx.session.scratch.quoteNonce;
  return typeof n === "string" ? n : undefined;
}
