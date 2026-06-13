/**
 * Conversation registry. Each entry pairs a conversation builder with the name
 * it is registered under (via createConversation) and how it is entered. main.ts
 * uses this list to register both the conversation middleware and its entry
 * trigger (callback pattern / command / reply-keyboard text).
 */
import type { MyContext, MyConversation } from "../context";
import { ticketUserReplyConversation } from "./customer";
import { proofConversation, voucherConversation } from "./checkout";
import { supportConversation } from "./support";
import { rejectConversation } from "./reject";
import {
  stockUploadConversation,
  voucherCreateConversation,
  broadcastConversation,
  userSearchConversation,
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

import { supportLabels } from "../keyboards/customer";

export const CONVERSATIONS: ConvSpec[] = [
  // customer
  { name: "ticketUserReply", fn: ticketUserReplyConversation, callback: /^v1:ticket:reply:\d+$/ },
  // checkout
  { name: "proof", fn: proofConversation, callback: /^v1:checkout:proof:\d+$/ },
  { name: "voucher", fn: voucherConversation, callback: /^v1:voucher:start:\d+:\d+$/ },
  // support (3 entry triggers)
  { name: "support", fn: supportConversation, callback: /^v1:support:open$/, command: "support", hears: supportLabels() },
  // admin
  { name: "reject", fn: rejectConversation, callback: /^v1:adm:verif:reject:\d+$/ },
  { name: "stockUpload", fn: stockUploadConversation, callback: /^v1:adm:stock:add:\d+$/ },
  { name: "voucherCreate", fn: voucherCreateConversation, callback: /^v1:adm:vouch:new$/ },
  { name: "broadcast", fn: broadcastConversation, callback: /^v1:adm:broadcast:start$/ },
  { name: "userSearch", fn: userSearchConversation, callback: /^v1:adm:users:search$/ },
  { name: "setting", fn: settingConversation, callback: /^v1:adm:settings:set:.+$/ },
  { name: "productCreate", fn: productCreateConversation, callback: /^v1:adm:prod:new$/ },
  { name: "productEdit", fn: productEditConversation, callback: /^v1:adm:prod:(rename|price):\d+$/ },
  { name: "bulkPricing", fn: bulkPricingConversation, callback: /^v1:adm:bulk:new:\d+$/ },
  { name: "ticketReply", fn: ticketReplyConversation, callback: /^v1:adm:ticket:reply:\d+$/ },
];
