/**
 * Nickname-verification conversation — for an AUTO Game Top-Up SKU that
 * resolves to a nickname-check `gameCode` (admin override or catalog
 * auto-detect from Product.digiflazzBrand — see resolveNicknameGate's doc
 * comment, packages/db/src/crud/nickname.ts) AND has KokinPay credentials
 * configured (see `buildNicknameProviderEntries`), the buyer's target
 * account id (+ zone/server, when the game requires them) is looked up via
 * `NicknameService` BEFORE payment, and the resolved nickname is shown back
 * to the buyer for confirmation. Entered
 * programmatically from checkout.ts's showOrderConfirmation (not from a
 * callback/command trigger — see conversations/index.ts) once per checkout
 * attempt; scratch.customerData being unset is what makes the gate re-enter
 * this same conversation on a retry — same re-entry contract as
 * customerInfo.ts's manual_with_info gate (see that gate's doc comment).
 *
 * Single-bubble wizard, same shape as customerInfoConversation: menuAnchor
 * prompt, consumeInput on the typed reply, re-prompt the SAME bubble on a
 * validation error, and the standard /start, /cancel, persistent-label
 * escapes.
 *
 * Storage: the confirmed target (+ zone/server + nickname, when found) is
 * stashed into scratch.customerData in the exact same
 * JSON.stringify(Array<Record<string,string>>) shape customerInfo.ts uses —
 * NOT a new scratch key — so the existing customerData threading into
 * createOrderDirect/createInternalOrder/etc. (checkout.ts's buyNow*
 * handlers) picks it up with zero further changes there.
 *
 * Graceful degrade: a definitive "not found" answer re-prompts the buyer
 * (typo protection) with an error line and a 'Continue anyway' escape
 * (final-review Important #2 — see the not_found branch below), looping back
 * to the target-id step. A non-definitive failure (every configured provider
 * errored/timed out, or — defensively — the config disappeared between the
 * gate's check and this conversation's own re-check) must NOT strand the
 * buyer over a transient provider hiccup: it proceeds straight to
 * confirmation with the typed target stored but no confirmed nickname,
 * mirroring the storefront's "couldn't determine anything stays silent"
 * discipline (apps/storefront/src/routes/apiTopup.ts).
 *
 * Replay-safety: every DB read / network call (including the
 * NicknameService.checkNickname lookup, which happens mid-loop, between
 * wait()s) is wrapped in conversation.external() — same discipline as
 * conversations/checkout.ts's voucherConversation. Unlike that
 * conversation's externals, every external() here is collapsed down to
 * return ONLY plain JSON-serializable values (final-review Important #3):
 * `NicknameServiceProviderEntry[]` (built by buildNicknameProviderEntries)
 * carries a `provider` object with a `checkNickname` method closing over API
 * credentials, and grammY's own JSDoc says external() results should be
 * "primitive values or POJOs" — its storage/replay log clones (and, under a
 * persistent session adapter, serializes) whatever crosses that boundary, so
 * a closure-carrying value would silently lose its methods on replay. That
 * array — and the raw Prisma `Denomination` (Decimal/Date fields) this
 * conversation used to also pass through external() — never leaves an
 * external() callback: entries are built AND consumed (via NicknameService)
 * inside the same external(), and the denomination row is reduced to a
 * small POJO (`NicknameCheckConfig`) before it's returned.
 */
import { prisma, getDenominationWithProduct, buildNicknameProviderEntries, resolveNicknameGate } from "@app/db";
import { NicknameService } from "@app/core/nickname/service";
import { logger } from "@app/core/logger";
import type { MyContext, MyConversation } from "../context";
import { menuAnchor, consumeInput } from "../util/chat";
import { esc } from "../util/format";
import { coreT } from "../util/i18n";
import * as ckb from "../keyboards/customer";
import { showOrderConfirmation, renderOrderConfirmation } from "../handlers/checkout";
import { startCommand, handleProductNumber } from "../handlers/customer";

/** Plain, JSON-serializable summary of the denomination/game config this
 * conversation needs — the ONLY thing the config-resolving external() call
 * returns, instead of the raw Prisma row (which carries Decimal/Date fields)
 * or the gate's `gameCode` computed inline outside external() (which would
 * re-duplicate the shared resolveNicknameGate rule). */
interface NicknameCheckConfig {
  productName: string;
  requiresZone: boolean;
  requiresServer: boolean;
  gameCode: string | null;
}

function isCmd(ctx: MyContext, cmd: string): boolean {
  const text = ctx.message?.text ?? "";
  return text === `/${cmd}` || text.startsWith(`/${cmd} `) || text.startsWith(`/${cmd}@`);
}

/** One prompt, with an optional validation/not-found error line prepended —
 * mirrors customerInfo.ts's fieldPrompt helper. */
function promptWithError(
  lang: string,
  bodyKey: string,
  args: Record<string, unknown> = {},
  errorKey?: string,
): string {
  const body = coreT(bodyKey, lang, args);
  return errorKey ? `${coreT(errorKey, lang)}\n\n${body}` : body;
}

type Step = "target" | "zone" | "server" | "confirm";

export async function nicknameCheckConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const productId = ctx.session.scratch.pendingNicknameProductId as number;
  const quantity = ctx.session.scratch.pendingNicknameQuantity as number;

  // Single external() call, returning only the small POJO defined above —
  // the raw Prisma denomination row (Decimal/Date fields) never crosses the
  // boundary. Same rule as the gate that entered us (checkout.ts's
  // showOrderConfirmation) and the storefront's own gate (apiTopup.ts POST
  // /topup/check-account), via the shared resolveNicknameGate — re-checked
  // here defensively in case config changed in the moment between that
  // gate's read and this conversation actually starting. `resolveNicknameGate`
  // already returns requiresZone/requiresServer alongside gameCode, so there
  // is no separate relation read for them.
  const config: NicknameCheckConfig | null = await conversation.external(async () => {
    const denom = await getDenominationWithProduct(prisma, productId);
    if (!denom) return null;
    const { gameCode, requiresZone, requiresServer } = resolveNicknameGate(denom);
    return {
      productName: denom.product.name,
      requiresZone,
      requiresServer,
      gameCode,
    };
  });
  if (!config || !config.gameCode) {
    // Defensive — shouldn't normally happen since the gate just verified this.
    // Nothing to collect; go straight to confirmation.
    await renderOrderConfirmation(ctx, productId, quantity);
    return;
  }
  const { productName, requiresZone, requiresServer, gameCode } = config;
  // Defensive pre-check, same race as above (e.g. an admin cleared the
  // KokinPay credentials a moment ago) — entries are built and immediately
  // reduced to a plain count inside this external(), never returned as an
  // array (that array's `provider` object carries a `checkNickname` closure —
  // see the file-header comment on external() discipline).
  const providersConfigured = await conversation.external(async () => {
    const entries = await buildNicknameProviderEntries(prisma, gameCode);
    return entries.length;
  });
  if (providersConfigured === 0) {
    // Skip the check, proceed exactly like an unconfigured product would.
    await renderOrderConfirmation(ctx, productId, quantity);
    return;
  }

  if (ctx.callbackQuery) await ctx.answerCallbackQuery();
  const cancelKb = ckb.voucherCancelKb(productId, quantity, lang);
  await menuAnchor(ctx, promptWithError(lang, "checkout.nickname_target_prompt", { product: esc(productName) }), cancelKb);

  let step: Step = "target";
  let target = "";
  let zone: string | undefined;
  let server: string | undefined;
  let foundNickname: string | undefined;

  for (;;) {
    const u = await conversation.wait();
    const data = u.callbackQuery?.data ?? "";
    if (data.startsWith("v1:buy:")) {
      // voucherCancelKb routes to v1:buy — abandon the check and re-enter
      // showOrderConfirmation's gate cleanly (customerData is still unset,
      // so a fresh "Buy" tap will land back in this same wizard).
      await u.answerCallbackQuery();
      await showOrderConfirmation(u, productId, quantity);
      return;
    }
    if (isCmd(u, "start")) {
      await startCommand(u);
      return;
    }
    if (isCmd(u, "cancel")) {
      await showOrderConfirmation(u, productId, quantity);
      return;
    }
    if (data === ckb.cb("nick", "continue")) {
      // 'Continue anyway' from the not_found screen (final-review Important
      // #2) — only ever rendered there, after a definitive not-found, so
      // target (+ zone/server, when collected) already holds the buyer's
      // last-typed values. Proceed unverified, matching the non-definitive
      // graceful-degrade path below.
      await u.answerCallbackQuery();
      u.session.scratch.customerData = JSON.stringify([{ target, ...(zone ? { zone } : {}), ...(server ? { server } : {}) }]);
      delete u.session.scratch.pendingNicknameProductId;
      delete u.session.scratch.pendingNicknameQuantity;
      await renderOrderConfirmation(u, productId, quantity);
      return;
    }
    const text = u.message?.text;
    if (text && ckb.isPersistentLabel(text)) {
      await handleProductNumber(u);
      return;
    }

    if (step === "confirm") {
      if (data === ckb.cb("nick", "confirm")) {
        await u.answerCallbackQuery();
        u.session.scratch.customerData = JSON.stringify([
          {
            target,
            ...(zone ? { zone } : {}),
            ...(server ? { server } : {}),
            ...(foundNickname ? { nickname: foundNickname } : {}),
          },
        ]);
        delete u.session.scratch.pendingNicknameProductId;
        delete u.session.scratch.pendingNicknameQuantity;
        await renderOrderConfirmation(u, productId, quantity);
        return;
      }
      if (data === ckb.cb("nick", "retry")) {
        await u.answerCallbackQuery();
        step = "target";
        target = "";
        zone = undefined;
        server = undefined;
        foundNickname = undefined;
        await menuAnchor(u, promptWithError(lang, "checkout.nickname_target_prompt", { product: esc(productName) }), cancelKb);
        continue;
      }
      // An inline tap that doesn't match confirm/retry/v1:buy: (e.g. a stale/
      // duplicate tap) — clear its spinner instead of leaving it hanging
      // (M-22 fix, mirrored from customerInfo.ts).
      if (u.callbackQuery) await u.answerCallbackQuery({ text: coreT("error.stale_screen", lang) });
      continue;
    }

    if (!text) {
      if (u.callbackQuery) await u.answerCallbackQuery({ text: coreT("error.stale_screen", lang) });
      continue;
    }

    // Anchor pattern: the typed answer is deleted and every retry edits the
    // step's prompt bubble instead of stacking error replies.
    await consumeInput(u);
    const value = text.trim();
    if (!value) {
      const key =
        step === "target" ? "checkout.nickname_target_prompt" : step === "zone" ? "checkout.nickname_zone_prompt" : "checkout.nickname_server_prompt";
      const args = step === "target" ? { product: esc(productName) } : {};
      await menuAnchor(u, promptWithError(lang, key, args, "checkout.nickname_value_required"), cancelKb);
      continue;
    }

    if (step === "target") {
      target = value;
      if (requiresZone) {
        step = "zone";
        await menuAnchor(u, coreT("checkout.nickname_zone_prompt", lang), cancelKb);
        continue;
      }
      if (requiresServer) {
        step = "server";
        await menuAnchor(u, coreT("checkout.nickname_server_prompt", lang), cancelKb);
        continue;
      }
    } else if (step === "zone") {
      zone = value;
      if (requiresServer) {
        step = "server";
        await menuAnchor(u, coreT("checkout.nickname_server_prompt", lang), cancelKb);
        continue;
      }
    } else {
      server = value;
    }

    // Every field this game requires has been collected — run the lookup.
    // Entries are built AND consumed inside this one external() call, so the
    // closure-carrying NicknameServiceProviderEntry[] never crosses the
    // boundary — only the plain result object plus two primitive fields kept
    // for the not-found diagnostic log below.
    const lookup = await conversation.external(async () => {
      const entries = await buildNicknameProviderEntries(prisma, gameCode);
      const lookupResult = await new NicknameService(entries).checkNickname({ target, zone, server });
      return {
        result: lookupResult,
        providersConfigured: entries.length,
        lastConfiguredProviderId: entries[entries.length - 1]?.provider.id ?? null,
      };
    });
    const { result } = lookup;
    if (result.status === "found") {
      foundNickname = result.nickname;
      step = "confirm";
      await menuAnchor(
        u,
        coreT("checkout.nickname_found", lang, { nickname: esc(result.nickname) }),
        ckb.nicknameConfirmKb(productId, quantity, lang),
      );
      continue;
    }
    if (result.status === "not_found" && result.definitive) {
      // A provider gave a clear "no such account" answer — likely a typo.
      // Loop back to the target-id step so the buyer can retype. Deliberately
      // NOT clearing target/zone/server here (unlike before final-review
      // Important #2): the 'Continue anyway' escape below needs the buyer's
      // last-typed values still available, and retyping the target still
      // re-collects zone/server from scratch on its own — this Game's
      // requiresZone/requiresServer flags re-trigger those prompts
      // regardless of what's currently stored in those variables.
      //
      // Diagnostic log — mirrors apps/storefront/src/routes/apiTopup.ts's
      // logger.info at its own definitive not-found point: a misconfigured
      // nicknameCheckGameCode override, or a catalog `code` KokinPay no
      // longer recognizes, can make the lookup return a non-retryable error.
      // Without this, an admin has no way to see that a SKU's nickname check
      // is silently dead. Only counts/ids — no credentials or raw provider
      // responses.
      logger.info(
        {
          productId,
          gameCode,
          providersConfigured: lookup.providersConfigured,
          lastConfiguredProviderId: lookup.lastConfiguredProviderId,
        },
        "Bot nickname check got a definitive not-found for one checkout attempt — buyer was offered a 'Continue anyway' escape; if this recurs for the same product, its nickname-check game code may be misconfigured.",
      );
      step = "target";
      await menuAnchor(
        u,
        promptWithError(lang, "checkout.nickname_target_prompt", { product: esc(productName) }, "checkout.nickname_not_found"),
        ckb.nicknameNotFoundKb(productId, quantity, lang),
      );
      continue;
    }
    // Non-definitive failure (every configured provider errored/timed out) —
    // graceful degrade, never strand the buyer over a transient provider
    // hiccup: proceed with the typed target, no confirmed nickname.
    u.session.scratch.customerData = JSON.stringify([{ target, ...(zone ? { zone } : {}), ...(server ? { server } : {}) }]);
    delete u.session.scratch.pendingNicknameProductId;
    delete u.session.scratch.pendingNicknameQuantity;
    await renderOrderConfirmation(u, productId, quantity);
    return;
  }
}
