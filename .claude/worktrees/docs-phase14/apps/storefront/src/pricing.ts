/**
 * Price model helpers (plan.md §15): ONE central price in Rupiah
 * (Product.price = IDR, the source of truth) with a derived USDT figure shown
 * BESIDE it as information for every buyer. No per-buyer currency, no IP
 * detection — buyers pick the transaction currency at PAY time only
 * (USDT → Binance, IDR → TokoPay).
 *
 * The implementations are shared with the bot via @app/core (pure conversion)
 * and @app/db (rate lookup + order finalization); re-exported here so the
 * storefront keeps a single import site.
 */
export { usdtFromIdr } from "@app/core/formatters";
export { getUsdIdrRate, finalizeOrderPayment, USD_IDR_RATE_KEY } from "@app/db";
