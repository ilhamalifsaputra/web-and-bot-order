/**
 * Nickname-verification conversation — for a Game Top-Up SKU (AUTO, or
 * MANUAL_WITH_INFO since the I-6 fix) that resolves to a nickname-check
 * `gameCode` (admin override or catalog auto-detect from
 * Product.digiflazzBrand — see resolveNicknameGate's doc comment,
 * packages/db/src/crud/nickname.ts) AND has KokinPay credentials configured
 * (see `buildNicknameProviderEntries`), the buyer's target account id (+
 * zone/server, when the game requires them) is looked up via
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
 * handlers) picks it up with zero further changes there. Critically, the
 * unit is keyed through the SKU's OWN `additionalFields` (via
 * `nicknameFieldMapping`/`buildCustomerDataUnit` below) — NOT hardcoded
 * `{target, zone, server}` keys — because that's the shape
 * `buildDigiflazzCustomerNo` and `computeAccountDiagnosticNote` actually read
 * (final-review round 2 fix; see fieldMapping.ts's doc comment for why).
 *
 * Multi-unit handoff and field coverage (final-review round 3/4 — see
 * `finalizeNicknameCheck` below for the exact branches): this wizard only
 * ever collects ONE unit's worth of account info. Whether that's enough to
 * finalize checkout directly depends on FIELD COVERAGE, not just quantity —
 * `nicknameFieldMapping` only ever fills the SKU's first 1-3 `additionalFields`
 * (target, optionally zone, optionally server); any REQUIRED field beyond
 * that range would fail `validateCustomerData` at order-creation time if left
 * unset. For a MANUAL_WITH_INFO SKU: if every required field is covered and
 * `quantity > 1`, the collected unit is stashed as
 * `scratch.prefilledCustomerDataUnit` and control hands off to `customerInfo`
 * to collect the remaining units (customerInfo.ts picks that prefilled unit
 * up as unit 1 and continues from unit 2); if a required field is NOT
 * covered (regardless of quantity), this wizard's result is discarded
 * entirely and customerInfo re-collects every field for every unit from
 * scratch. AUTO SKUs always finalize immediately regardless of coverage or
 * quantity (AUTO never goes through customerInfo/validateCustomerData), but
 * log a warning when coverage is incomplete since the resulting
 * Digiflazz customerNo may be missing a value.
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
import { nicknameFieldMapping, buildCustomerDataUnit } from "@app/core/nickname/fieldMapping";
import { parseAdditionalFields, type AdditionalField } from "@app/core/deliveryFields";
import { DeliveryType } from "@app/core/enums";
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
  /** The SKU's own admin-defined additionalFields — nicknameFieldMapping
   * writes the collected answer into these keys, positionally, instead of
   * the old hardcoded {target,zone,server} shape (final-review round 2 —
   * this is what makes buildDigiflazzCustomerNo/computeAccountDiagnosticNote
   * actually see the data). parseAdditionalFields is a pure function (no DB
   * call), so parsing it inside this same external() call is fine — see
   * this file's header comment on external() discipline. */
  fields: AdditionalField[];
  /** The denomination's own deliveryType — needed to decide whether an
   * incompletely-covered or quantity > 1 checkout hands off to customerInfo
   * (MANUAL_WITH_INFO only; see finalizeNicknameCheck's field-coverage logic
   * below). */
  deliveryType: string;
}

/**
 * The single finalize path for a nickname-check attempt — every place in
 * this file that completes the wizard (the confirm tap, the not-found
 * 'Continue anyway' escape, and the non-definitive graceful-degrade
 * fallthrough) MUST route through this function so the multi-unit handoff
 * branching below can never drift between them (final-review round 2 —
 * missing one of these branches would silently reintroduce the
 * empty-customerNo bug for whichever branch was missed).
 *
 * Field-coverage gate (final-review round 3 — replaces round 2's
 * `quantity > 1` heuristic, which was the wrong condition; refined in round 4
 * to count only REQUIRED fields, since validateCustomerData tolerates a
 * blank optional one): the real constraint isn't quantity, it's whether
 * nicknameFieldMapping actually fills every REQUIRED additionalField this SKU
 * defines. A MANUAL_WITH_INFO SKU whose REQUIRED admin-defined fields aren't
 * fully covered by this game's requiresZone/requiresServer flags (e.g. 2
 * required fields but the matched game only accounts for 1) can NEVER produce
 * a complete customerData unit
 * from this wizard alone — finalizing anyway would submit an incomplete unit
 * that validateCustomerData (packages/core/src/deliveryFields.ts, called from
 * packages/db/src/crud/orders.ts at order-creation time, gated to
 * MANUAL_WITH_INFO) rejects, and since nothing clears scratch.customerData on
 * that rejection, the buyer would be stuck retrying the identical failure
 * forever. So under-coverage MANUAL_WITH_INFO always hands off to
 * customerInfo to re-collect EVERY field from a clean slate, regardless of
 * quantity — the mapped unit from this wizard is discarded entirely for
 * customerData purposes (the live KokinPay verification still ran and told
 * the buyer their account is valid; it just can't be reused to pre-fill an
 * incompletely-covered field schema).
 *
 * When coverage IS full: quantity === 1 (any deliveryType), OR the SKU has no
 * additionalFields, OR deliveryType is AUTO all finalize immediately
 * (customerData = [unit], straight to confirmation) — unchanged from round 2.
 * Only a MANUAL_WITH_INFO SKU with full coverage AND quantity > 1 AND at
 * least one additionalField hands the remaining units off to customerInfo,
 * prefilled with this one verified unit (round 2's original behavior).
 *
 * AUTO doesn't go through validateCustomerData's hard block, so under-coverage
 * there can't strand a buyer the same way — it still finalizes directly, but
 * logs a warning since it's the same root misconfiguration and silently ships
 * an incomplete customerNo to the supplier.
 */
async function finalizeNicknameCheck(
  u: MyContext,
  productId: number,
  quantity: number,
  deliveryType: string,
  fields: AdditionalField[],
  requiresZone: boolean,
  requiresServer: boolean,
  answer: { target: string; zone?: string; server?: string; nickname?: string },
): Promise<void> {
  delete u.session.scratch.pendingNicknameProductId;
  delete u.session.scratch.pendingNicknameQuantity;
  // Clear any prefilled unit inherited from a PRIOR checkout attempt (final
  // review round 4/5) — hoisted here, before every branch below, rather than
  // only inside the no-prefill handoff branch: the direct-finalize tail at
  // the bottom of this function also exits without entering customerInfo,
  // and would otherwise leave a stale value in place too if a PRIOR attempt
  // set one and customerInfo exited before its own cleanup (an early return
  // or a thrown error). The quantity>1+fully-covered branch below sets its
  // own fresh value immediately after this, so hoisting the delete here
  // doesn't change that branch's behavior.
  delete u.session.scratch.prefilledCustomerDataUnit;

  const mapping = nicknameFieldMapping(fields, requiresZone, requiresServer);
  const mappedFieldCount = mapping ? 1 + (mapping.zoneKey ? 1 : 0) + (mapping.serverKey ? 1 : 0) : 0;
  // Coverage only matters for REQUIRED fields — validateCustomerData (the
  // actual hard block at order-creation) accepts a blank optional field, so
  // an uncovered field beyond the mapped range is only a real problem when
  // it's required. Counting ALL fields here (final-review round 4) made this
  // gate over-trigger on the common, harmless shape of one required target
  // field plus one optional server/zone field, discarding a successful live
  // verification and making the buyer retype everything for no reason.
  const uncoveredRequiredFieldExists = fields.slice(mappedFieldCount).some((f) => f.required);
  const fullyCovered = fields.length === 0 || !uncoveredRequiredFieldExists;

  if (deliveryType === DeliveryType.MANUAL_WITH_INFO && !fullyCovered) {
    // The SKU has a REQUIRED admin-defined field this game's
    // requiresZone/requiresServer flags don't account for (e.g. a required
    // "zone" field on a game whose catalog entry says requiresZone:false) —
    // finalizing here would submit an incomplete unit that
    // validateCustomerData rejects at order-creation time, permanently
    // blocking checkout for this SKU (Critical finding, final-review round
    // 3). Discard this wizard's mapped result for customerData purposes —
    // the live KokinPay verification still ran and told the buyer their
    // account is valid, it just can't be reused to pre-fill an
    // incompletely-covered field schema — and let customerInfo re-collect
    // EVERY field for EVERY unit from a clean slate, exactly as if this game
    // hadn't matched the nickname catalog at all. (Any stale
    // prefilledCustomerDataUnit from a prior attempt is already cleared
    // above, before this branch.)
    u.session.scratch.pendingInfoProductId = productId;
    u.session.scratch.pendingInfoQuantity = quantity;
    await u.conversation.enter("customerInfo");
    return;
  }

  const unit = buildCustomerDataUnit(fields, requiresZone, requiresServer, answer);

  if (deliveryType === DeliveryType.MANUAL_WITH_INFO && quantity > 1 && fields.length > 0) {
    // fullyCovered is true here (the branch above would have returned
    // otherwise) — safe to prefill this one verified unit and let
    // customerInfo collect the rest.
    u.session.scratch.pendingInfoProductId = productId;
    u.session.scratch.pendingInfoQuantity = quantity;
    u.session.scratch.prefilledCustomerDataUnit = JSON.stringify(unit);
    await u.conversation.enter("customerInfo");
    return;
  }

  if (deliveryType === DeliveryType.AUTO && mapping && mappedFieldCount < fields.length) {
    // AUTO doesn't go through validateCustomerData's hard block (confirmed —
    // see this file's finalizeNicknameCheck doc comment). But it's the same
    // root misconfiguration (an admin-typed nicknameCheckGameCode, or a
    // catalog entry, whose requiresZone/requiresServer doesn't match this
    // SKU's actual field layout) and it silently ships an incomplete
    // customerNo to Digiflazz — visible only here, not blocking, purely
    // diagnostic.
    logger.warn(
      { productId, fieldsConfigured: fields.length, fieldsMapped: mappedFieldCount },
      "Nickname-check result covers fewer additionalFields than this AUTO SKU defines — the Digiflazz customerNo sent to the supplier may be missing a value. Check whether this SKU's nicknameCheckGameCode override (or its auto-detected game's requiresZone/requiresServer flags) match its actual field layout.",
    );
  }

  u.session.scratch.customerData = JSON.stringify([unit]);
  await renderOrderConfirmation(u, productId, quantity);
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
      fields: parseAdditionalFields(denom.additionalFields),
      deliveryType: denom.deliveryType,
    };
  });
  if (!config || !config.gameCode) {
    // Defensive — shouldn't normally happen since the gate just verified this.
    // Nothing to collect; go straight to confirmation.
    await renderOrderConfirmation(ctx, productId, quantity);
    return;
  }
  const { productName, requiresZone, requiresServer, gameCode, fields, deliveryType } = config;
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
      await finalizeNicknameCheck(u, productId, quantity, deliveryType, fields, requiresZone, requiresServer, { target, zone, server });
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
        await finalizeNicknameCheck(u, productId, quantity, deliveryType, fields, requiresZone, requiresServer, {
          target,
          zone,
          server,
          nickname: foundNickname,
        });
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
    await finalizeNicknameCheck(u, productId, quantity, deliveryType, fields, requiresZone, requiresServer, { target, zone, server });
    return;
  }
}
