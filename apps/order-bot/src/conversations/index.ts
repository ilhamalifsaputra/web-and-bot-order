/**
 * Conversation registry. Each entry pairs a conversation builder with the name
 * it is registered under (via createConversation) and how it is entered. main.ts
 * uses this list to register both the conversation middleware and its entry
 * trigger (callback pattern / command / reply-keyboard text).
 */
import type { MyContext, MyConversation } from "../context";
import { ticketUserReplyConversation } from "./customer";
import { voucherConversation } from "./checkout";
import { customerInfoConversation } from "./customerInfo";
import { editCustomerInfoConversation } from "./editCustomerInfo";
import { supportConversation } from "./support";
import { rejectConversation } from "./reject";
import {
  stockUploadConversation,
  voucherCreateConversation,
  broadcastConversation,
  userSearchConversation,
  userBanConversation,
  settingConversation,
  productCreateConversation,
  productEditConversation,
  bulkPricingConversation,
  ticketReplyConversation,
} from "./admin";

export type ConvFn = (conversation: MyConversation, ctx: MyContext) => Promise<void>;

export interface ConvSpec {
  name: string;
  fn: ConvFn;
  /** Callback-data pattern(s) that enter the conversation. */
  callback?: RegExp;
  /** Slash command that enters the conversation. */
  command?: string;
  /** Exact reply-keyboard label(s) that enter the conversation (any language). */
  hears?: string | string[];
}

export const CONVERSATIONS: ConvSpec[] = [
  // customer
  { name: "ticketUserReply", fn: ticketUserReplyConversation, callback: /^v1:ticket:reply:\d+$/ },
  // checkout
  { name: "voucher", fn: voucherConversation, callback: /^v1:voucher:start:\d+:\d+$/ },
  // Entered programmatically only (checkout.ts's showOrderConfirmation calls
  // ctx.conversation.enter("customerInfo") for a manual_with_info SKU) — no
  // callback/command/hears trigger needed. main.ts's registration loop
  // (`for (const spec of CONVERSATIONS) bot.use(createConversation(...))`)
  // registers every spec unconditionally regardless of whether it has a
  // trigger, so this still becomes .enter()-able; the SEPARATE entry-trigger
  // loop right after it just no-ops for a spec with none (each `if
  // (spec.callback)`/`if (spec.command)`/`if (spec.hears)` simply skips).
  { name: "customerInfo", fn: customerInfoConversation },
  // Entered programmatically only (callbacks.ts's dispatchOrder calls
  // ctx.conversation.enter("editCustomerInfo") for a v1:order:editinfo:<id>
  // tap on a PROCESSING manual_with_info order) — same no-trigger shape as
  // customerInfo above (Task 9).
  { name: "editCustomerInfo", fn: editCustomerInfoConversation },
  // support (entry via the inline Help Center button + /support command)
  { name: "support", fn: supportConversation, callback: /^v1:support:open$/, command: "support" },
  // admin
  { name: "reject", fn: rejectConversation, callback: /^v1:adm:verif:reject:\d+$/ },
  { name: "stockUpload", fn: stockUploadConversation, callback: /^v1:adm:stock:add:\d+$/ },
  { name: "voucherCreate", fn: voucherCreateConversation, callback: /^v1:adm:vouch:new$/ },
  { name: "broadcast", fn: broadcastConversation, callback: /^v1:adm:broadcast:start$/ },
  { name: "userSearch", fn: userSearchConversation, callback: /^v1:adm:users:search$/ },
  { name: "userBan", fn: userBanConversation, callback: /^v1:adm:users:(ban|unban):\d+$/ },
  { name: "setting", fn: settingConversation, callback: /^v1:adm:settings:set:.+$/ },
  { name: "productCreate", fn: productCreateConversation, callback: /^v1:adm:prod:new$/ },
  { name: "productEdit", fn: productEditConversation, callback: /^v1:adm:prod:(rename|price):\d+$/ },
  { name: "bulkPricing", fn: bulkPricingConversation, callback: /^v1:adm:bulk:new:\d+$/ },
  { name: "ticketReply", fn: ticketReplyConversation, callback: /^v1:adm:ticket:reply:\d+$/ },
];
