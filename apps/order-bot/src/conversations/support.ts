import { randomUUID } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { SUPPORT_CATEGORIES, supportIssue } from "@app/core/supportCatalog";
import { supportMediaAvailable } from "@app/core/supportMedia";
import { botToken } from "@app/core/runtime";
import { prisma, createTicket, getOrder, listUserOrders, getOpenTicketForOrder, logCustomerAction, ingestSupportTelegramMedia } from "@app/db";
import type { MyContext, MyConversation } from "../context";
import { consumeInput, menuAnchor } from "../util/chat";
import { t } from "../util/i18n";
import { esc } from "../util/format";
import * as ckb from "../keyboards/customer";
import { handleProductNumber, showMainMenu } from "../handlers/customer";

const TTL = 30 * 60_000;
const callback = (action: string) => `v1:support:v2:${action}`;
function navigation(ctx: MyContext, back = true) {
  const keyboard = new InlineKeyboard();
  if (back) keyboard.text(t(ctx, "helpdesk.back"), callback("back"));
  return keyboard.text(t(ctx, "helpdesk.cancel"), callback("cancel"));
}

export async function supportConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  const user = ctx.session.dbUser!;
  const draftId = await conversation.external(() => randomUUID());
  const started = await conversation.now();
  const orders = await conversation.external(() => listUserOrders(prisma, user.id, 50, 0));
  const entryOrderId = Number(ctx.callbackQuery?.data?.match(/^v1:support:open:(\d+)$/)?.[1]);
  const linkedOrder = Number.isSafeInteger(entryOrderId) && entryOrderId > 0 ? await conversation.external(() => getOrder(prisma, entryOrderId)) : null;
  const preselectedOrder = linkedOrder?.userId === user.id ? linkedOrder : null;
  const mediaEnabled = await conversation.external(() => supportMediaAvailable());
  let current = ctx;
  let step: "category" | "issue" | "order" | "description" | "media" | "review" = "category";
  let category = ""; let issueKey = ""; let orderId: number | null = preselectedOrder?.id ?? null; let body = ""; let orderPage = 0;
  const attachments: string[] = [];
  const acceptedInputs: MyContext[] = [];
  let error = "";
  if (ctx.callbackQuery) await ctx.answerCallbackQuery();
  for (;;) {
    const issue = supportIssue(category, issueKey);
    let text: string; let keyboard: InlineKeyboard;
    if (step === "category") {
      text = t(current, "helpdesk.choose_category"); keyboard = new InlineKeyboard();
      for (const item of SUPPORT_CATEGORIES) keyboard.text(t(current, `helpdesk.category_${item.key.toLowerCase()}`), callback(`category:${item.key}`)).row();
      keyboard.text(t(current, "helpdesk.cancel"), callback("cancel"));
    } else if (step === "issue") {
      text = t(current, "helpdesk.choose_issue"); keyboard = new InlineKeyboard();
      const selected = SUPPORT_CATEGORIES.find((item) => item.key === category)!;
      for (const key of selected.issues) keyboard.text(t(current, `helpdesk.issue.${category.toLowerCase()}_${key}`), callback(`issue:${key}`)).row();
      keyboard.row().text(t(current, "helpdesk.back"), callback("back")).text(t(current, "helpdesk.cancel"), callback("cancel"));
    } else if (step === "order") {
      const slice = orders.slice(orderPage * 5, orderPage * 5 + 5);
      text = t(current, "helpdesk.choose_order") + "\n\n" + slice.map((o, index) => `${index + 1}. <code>${esc(o.orderCode)}</code> ${esc(o.items[0]?.product?.name?.slice(0, 60) ?? "")}`).join("\n");
      keyboard = new InlineKeyboard();
      slice.forEach((o, index) => keyboard.text(String(index + 1), callback(`order:${o.id}`)).row());
      if (orderPage) keyboard.text(t(current, "helpdesk.previous"), callback("previous"));
      if ((orderPage + 1) * 5 < orders.length) keyboard.text(t(current, "helpdesk.next"), callback("next"));
      keyboard.row().text(t(current, "helpdesk.no_order"), callback("order:skip")).row().text(t(current, "helpdesk.back"), callback("back")).text(t(current, "helpdesk.cancel"), callback("cancel"));
    } else if (step === "description") { text = t(current, "helpdesk.ask_description"); keyboard = navigation(current); }
    else if (step === "media") { text = `${t(current, mediaEnabled ? "helpdesk.ask_media" : "helpdesk.media_unavailable")}\n${attachments.length}/3`; keyboard = new InlineKeyboard().text(t(current, attachments.length ? "helpdesk.review" : "helpdesk.skip"), callback("review")).row().text(t(current, "helpdesk.back"), callback("back")).text(t(current, "helpdesk.cancel"), callback("cancel")); }
    else {
      const order = preselectedOrder?.id === orderId ? preselectedOrder : orders.find((item) => item.id === orderId);
      text = `<b>${t(current, "helpdesk.review")}</b>\n${t(current, `helpdesk.category_${category.toLowerCase()}`)} / ${t(current, issue!.labelKey)}\n${order ? `<code>${esc(order.orderCode)}</code>` : t(current, "helpdesk.no_order")}\n\n${esc(body.slice(0, 1200))}\n\n${t(current, "helpdesk.attachments")}: ${attachments.length}`;
      keyboard = new InlineKeyboard().text(t(current, "helpdesk.confirm"), callback("submit")).row().text(t(current, "helpdesk.back"), callback("back")).text(t(current, "helpdesk.cancel"), callback("cancel"));
    }
    await menuAnchor(current, `${text}${error ? `\n\n${error}` : ""}`, keyboard);
    error = "";
    current = await conversation.wait();
    const data = current.callbackQuery?.data ?? "";
    const action = data.startsWith(callback("")) ? data.slice(callback("").length) : "";
    if (current.callbackQuery) await current.answerCallbackQuery();
    const input = current.message?.text;
    if (input && ckb.isPersistentLabel(input)) return void await handleProductNumber(current);
    if (input?.startsWith("/start") || data === "v1:menu:main" || action === "cancel" || input === "/cancel") return void await showMainMenu(current);
    if (await conversation.now() - started > TTL) { await menuAnchor(current, t(current, "helpdesk.session_expired"), ckb.backToMain(current.session.lang)); return; }
    if (action === "back") { step = step === "issue" ? "category" : step === "order" ? "issue" : step === "description" ? (issue?.order && orders.length ? "order" : "issue") : step === "media" ? "description" : "media"; continue; }
    if (step === "category" && action.startsWith("category:")) { const candidate = action.slice(9); if (SUPPORT_CATEGORIES.some((item) => item.key === candidate)) { category = candidate; issueKey = ""; orderId = (candidate === "ORDER" || candidate === "PAYMENT") ? preselectedOrder?.id ?? null : null; step = "issue"; } }
    else if (step === "issue" && action.startsWith("issue:")) { const selected = supportIssue(category, action.slice(6)); if (selected) { issueKey = selected.issue; step = selected.order && !orderId && orders.length ? "order" : "description"; } }
    else if (step === "order") {
      if (action === "previous") orderPage = Math.max(0, orderPage - 1);
      if (action === "next" && (orderPage + 1) * 5 < orders.length) orderPage++;
      if (action === "order:skip") { orderId = null; step = "description"; }
      else if (action.startsWith("order:")) { const selected = orders.find((item) => item.id === Number(action.slice(6))); if (selected) { const existing = await conversation.external(() => getOpenTicketForOrder(prisma, selected.id)); if (existing) { await menuAnchor(current, t(current, "support.duplicate_open_ticket", { id: existing.ticketNumber ?? existing.id, code: selected.orderCode }), ckb.ticketDuplicateKb(existing.id, current.session.lang)); return; } orderId = selected.id; step = "description"; } }
    } else if (step === "description" && input) {
      const trimmed = input.trim(); if (trimmed.length >= 10 && trimmed.length <= 2000) { body = trimmed; acceptedInputs.push(current); step = "media"; } else error = t(current, "helpdesk.description_quality");
    } else if (step === "media") {
      if (action === "review") step = "review";
      else if (current.message?.photo || current.message?.video) {
        if (!mediaEnabled || attachments.length >= 3) { error = t(current, mediaEnabled ? "web.support_attach_error_count" : "helpdesk.media_unavailable"); continue; }
        const photo = current.message.photo?.at(-1); const video = current.message.video; const media = photo ?? video!;
        try {
          const file = await current.api.getFile(media.file_id);
          const args = { ownerId: user.id, draftId, fileId: media.file_id, filePath: file.file_path ?? "", mime: photo ? "image/jpeg" : video?.mime_type ?? "video/mp4", bytes: file.file_size ?? media.file_size ?? 0 };
          const id = await conversation.external(async () => ingestSupportTelegramMedia(prisma, { ...args, token: botToken() ?? "" })); attachments.push(id); acceptedInputs.push(current);
        } catch { error = t(current, "helpdesk.upload_failed"); }
      }
    } else if (step === "review" && action === "submit") {
      const ticket = await conversation.external(async () => {
        const created = await createTicket(prisma, user.id, body, null, null, orderId, { category: issue!.category, subcategory: issueKey, subject: t(current, issue!.labelKey), origin: "BOT", requestKey: draftId, attachmentIds: attachments, dedupeOrder: true });
        await logCustomerAction(prisma, { customerId: user.id, telegramUserId: BigInt(current.from!.id), channel: "BOT", correlationId: String(current.update.update_id), action: "ticket_create", targetType: "ticket", targetId: created.id, details: "Created a support ticket via Telegram." });
        return { id: created.id, number: created.ticketNumber };
      });
      for (const accepted of acceptedInputs) await consumeInput(accepted);
      await menuAnchor(current, t(current, "helpdesk.received", { number: ticket.number }), new InlineKeyboard().text(t(current, "helpdesk.view"), `v1:ticket:view:${ticket.id}`).row().text(t(current, "menu.main"), "v1:menu:main")); return;
    }
  }
}
