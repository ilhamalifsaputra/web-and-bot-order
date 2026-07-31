/**
 * Support ticket conversation — port of support.py.
 * User: /support → describe issue → optionally attach up to 3 photos → submit.
 * The ticket is persisted and forwarded to the support group / admin DMs.
 */
import { InputMediaBuilder } from "grammy";
import { config } from "@app/core/config";
import { adminIds } from "@app/core/runtime";
import { SenderType } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { prisma, getSetting, createTicket, addTicketMessage, listUserOrders } from "@app/db";
import type { MyContext, MyConversation } from "../context";
import { smartEdit, menuAnchor } from "../util/chat";
import { t } from "../util/i18n";
import { esc } from "../util/format";
import { validateText } from "../util/validators";
import * as ckb from "../keyboards/customer";
import * as akb from "../keyboards/admin";
import { startCommand, handleProductNumber } from "../handlers/customer";

function isCmd(ctx: MyContext, cmd: string): boolean {
  const text = ctx.message?.text ?? "";
  return text === `/${cmd}` || text.startsWith(`/${cmd} `) || text.startsWith(`/${cmd}@`);
}

export async function supportConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  const info = ctx.session.dbUser!;
  const lang = ctx.session.lang;

  if (ctx.callbackQuery) await ctx.answerCallbackQuery();

  let intro = t(ctx, "support.intro");
  const contact = await conversation.external(() => getSetting(prisma, "support_contact"));
  if (contact) intro += `\n\nDirect contact: ${esc(contact)}`;
  await smartEdit(ctx, intro, ckb.backToMain(lang));

  // --- AWAITING_TICKET: description ---
  // lastCtx tracks the freshest waited context. @grammyjs/conversations
  // replays the conversation on every resume, so the entry `ctx` parameter
  // is a throwaway reconstruction of the FIRST update only — a menuAnchor
  // fallback (fresh send) after any wait() must write its new anchor id onto
  // the update that's actually being persisted (the latest `u`), never back
  // onto `ctx`, or the write is silently lost and the next render re-derives
  // a stale, already-abandoned anchor id (same "stray keyboard" bug this
  // conversation exists to avoid, just reached a different way). Matches the
  // ctx-then-u pattern used throughout checkout.ts/customerInfo.ts.
  let lastCtx: MyContext = ctx;
  let body: string;
  for (;;) {
    const u = await conversation.wait();
    lastCtx = u;
    if (isCmd(u, "start")) return void (await startCommand(u));
    if (isCmd(u, "cancel")) return void (await smartEdit(u, t(u, "menu.main"), ckb.backToMain(lang)));
    const text = u.message?.text;
    if (!text) continue;
    // A reply-keyboard menu tap (Terms, FAQ, My Orders, …) must not be captured
    // as the ticket text. Exit the conversation and run the tapped action so the
    // button behaves normally instead of silently filing a ticket.
    if (ckb.isPersistentLabel(text)) return void (await handleProductNumber(u));
    try {
      body = validateText(text, 2000, 3);
      break;
    } catch (e) {
      if (e instanceof ValidationError) {
        await u.reply(t(u, e.key, e.formatArgs), { parse_mode: "HTML" });
        continue;
      }
      throw e;
    }
  }

  // --- AWAITING_ORDER (optional): link a past order, or skip ---
  // listUserOrders is a DB read that happens BEFORE the photo step's wait()
  // calls below — it must be wrapped in conversation.external() (same reason
  // getSetting is, above line 34) so a replay triggered by a later wait()
  // doesn't re-run it.
  const orders = await conversation.external(() => listUserOrders(prisma, info.id, 5, 0));
  let orderId: number | null = null;
  if (orders.length) {
    await menuAnchor(lastCtx, t(lastCtx, "support.ask_order"), ckb.orderPickerKb(orders, lang));
    for (;;) {
      const u = await conversation.wait();
      lastCtx = u;
      if (isCmd(u, "start")) return void (await startCommand(u));
      if (isCmd(u, "cancel")) return void (await smartEdit(u, t(u, "menu.main"), ckb.backToMain(lang)));
      const labelText = u.message?.text;
      if (labelText && ckb.isPersistentLabel(labelText)) return void (await handleProductNumber(u));
      const data = u.callbackQuery?.data ?? "";
      if (data === "v1:support:order:skip") {
        await u.answerCallbackQuery();
        break;
      }
      const m = /^v1:support:order:(\d+)$/.exec(data);
      if (m) {
        const picked = parseInt(m[1]!, 10);
        const match = orders.find((o) => o.id === picked);
        if (match) {
          orderId = picked;
          await u.answerCallbackQuery({ text: t(u, "support.order_linked_toast", { code: match.orderCode }) });
          break;
        }
      }
      // Anything else (stray text, unrecognized tap) — keep waiting, but a
      // tap must still get its spinner cleared with feedback instead of
      // spinning until Telegram gives up (M-22 fix).
      if (u.callbackQuery) await u.answerCallbackQuery({ text: t(u, "error.stale_screen") });
    }
  }

  await menuAnchor(lastCtx, t(lastCtx, "support.ask_photos"), ckb.supportPhotoPromptKb(0, lang));

  // --- AWAITING_PHOTOS: up to 3, auto-submit at 3, or Submit button ---
  const photos: string[] = [];
  for (;;) {
    const u = await conversation.wait();
    lastCtx = u;
    const data = u.callbackQuery?.data ?? "";
    if (data === "v1:support:photos:done") {
      await u.answerCallbackQuery();
      break;
    }
    if (isCmd(u, "start")) return void (await startCommand(u));
    if (isCmd(u, "cancel")) return void (await smartEdit(u, t(u, "menu.main"), ckb.backToMain(lang)));
    const labelText = u.message?.text;
    if (labelText && ckb.isPersistentLabel(labelText)) return void (await handleProductNumber(u));
    const ph = u.message?.photo;
    if (ph && ph.length) {
      photos.push(ph.at(-1)!.file_id);
      if (photos.length >= 3) break;
      await u.api.sendMessage(u.chat!.id, t(u, "support.photo_added", { count: photos.length }), {
        parse_mode: "HTML",
        reply_markup: ckb.supportPhotoPromptKb(photos.length, lang),
      });
    } else if (u.callbackQuery) {
      // An inline tap that isn't "photos:done" (e.g. a stale/duplicate tap) —
      // clear its spinner instead of leaving it hanging (M-22 fix).
      await u.answerCallbackQuery({ text: t(u, "error.stale_screen") });
    }
  }

  // --- Submit (terminal) ---
  const photoFileIds = photos.length ? photos.join(",") : null;
  const ticket = await createTicket(prisma, info.id, body, photoFileIds, null, orderId);
  await addTicketMessage(prisma, {
    ticketId: ticket.id,
    senderType: SenderType.USER,
    senderId: info.id,
    content: body,
    photoFileIds,
  });

  await menuAnchor(lastCtx, t(lastCtx, "support.received"), ckb.backToMain(lang));

  const photoNote = photos.length ? `\n📎 ${photos.length} photo(s) attached` : "";
  const forwardText =
    `🆘 <b>New support ticket #${ticket.id}</b>\n` +
    `From: <code>${ctx.from!.id}</code> (@${esc(ctx.from!.username ?? "")})${photoNote}\n\n` +
    `${esc(body)}`;

  const targets = config.SUPPORT_GROUP_ID ? [config.SUPPORT_GROUP_ID] : adminIds();
  for (const chatId of targets) {
    if (!chatId) continue;
    try {
      await ctx.api.sendMessage(chatId, forwardText, {
        parse_mode: "HTML",
        reply_markup: akb.ticketReplyKb(ticket.id, "en"),
      });
      if (photos.length) {
        await ctx.api.sendMediaGroup(chatId, photos.map((fid) => InputMediaBuilder.photo(fid)));
      }
    } catch (err) {
      logger.error({ err }, `Failed to forward ticket ${ticket.id} to admin chat ${chatId} — that chat won't see the new ticket unless another admin chat in the list got it`);
    }
  }
}
