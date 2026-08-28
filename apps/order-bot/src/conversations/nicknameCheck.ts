/**
 * Nickname-verification conversation — for an AUTO Game Top-Up SKU whose
 * linked `Game` has nickname-check configured (`Game.nicknameSupported` AND
 * at least one `ProviderGameMapping` resolves to a credentialed provider
 * entry — see `buildNicknameProviderEntries`, Trustance reconciliation
 * Phase B Task 1), the buyer's target account id (+ zone/server, when the
 * Game requires them) is looked up via `NicknameService` BEFORE payment, and
 * the resolved nickname is shown back to the buyer for confirmation. Entered
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
 * (typo protection) with an error line, looping back to the target-id step.
 * A non-definitive failure (every configured provider errored/timed out, or
 * — defensively — the config disappeared between the gate's check and this
 * conversation's own re-check) must NOT strand the buyer over a transient
 * provider hiccup: it proceeds straight to confirmation with the typed
 * target stored but no confirmed nickname, mirroring the storefront's
 * "couldn't determine anything stays silent" discipline
 * (apps/storefront/src/routes/apiTopup.ts).
 *
 * Replay-safety: every DB read / network call (including the
 * NicknameService.checkNickname lookup, which happens mid-loop, between
 * wait()s) is wrapped in conversation.external() — same discipline as
 * conversations/checkout.ts's voucherConversation.
 */
import { prisma, getDenominationWithProduct, buildNicknameProviderEntries } from "@app/db";
import { NicknameService } from "@app/core/nickname/service";
import type { MyContext, MyConversation } from "../context";
import { menuAnchor, consumeInput } from "../util/chat";
import { esc } from "../util/format";
import { coreT } from "../util/i18n";
import * as ckb from "../keyboards/customer";
import { showOrderConfirmation, renderOrderConfirmation } from "../handlers/checkout";
import { startCommand, handleProductNumber } from "../handlers/customer";

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

  const denom = await conversation.external(() => getDenominationWithProduct(prisma, productId));
  const linkedGame = denom?.product?.game ?? null;
  const rawGameId = denom?.product?.gameId ?? null;
  // Same rule as the gate that entered us (checkout.ts's showOrderConfirmation)
  // and the storefront's own gate (apiTopup.ts POST /topup/check-account,
  // final-review Finding 3) — re-checked here defensively in case config
  // changed in the moment between that gate's read and this conversation
  // actually starting.
  const gameId = rawGameId != null && linkedGame?.isActive && linkedGame.nicknameSupported ? rawGameId : null;
  const legacyGameCode = denom?.nicknameCheckGameCode ?? null;
  if (!denom || (!gameId && !legacyGameCode)) {
    // Defensive — shouldn't normally happen since the gate just verified this.
    // Nothing to collect; go straight to confirmation.
    await renderOrderConfirmation(ctx, productId, quantity);
    return;
  }
  const entries = await conversation.external(() => buildNicknameProviderEntries(prisma, { gameId, legacyGameCode }));
  if (entries.length === 0) {
    // Defensive — same race as above (e.g. an admin disabled the last
    // enabled mapping a moment ago). Skip the check, proceed exactly like an
    // unconfigured product would.
    await renderOrderConfirmation(ctx, productId, quantity);
    return;
  }
  const service = new NicknameService(entries);
  const requiresZone = Boolean(linkedGame?.requiresZone);
  const requiresServer = Boolean(linkedGame?.requiresServer);
  const productName = denom.product.name;

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

    // Every field this Game requires has been collected — run the lookup.
    const result = await conversation.external(() => service.checkNickname({ target, zone, server }));
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
      // Loop back to the target-id step (and re-collect zone/server too,
      // since a wrong target can make an otherwise-correct zone/server moot).
      step = "target";
      target = "";
      zone = undefined;
      server = undefined;
      await menuAnchor(
        u,
        promptWithError(lang, "checkout.nickname_target_prompt", { product: esc(productName) }, "checkout.nickname_not_found"),
        cancelKb,
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
