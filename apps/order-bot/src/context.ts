/**
 * Bot context + session shape. Replaces PTB's `ContextTypes.DEFAULT_TYPE` and
 * `context.user_data`. Session is per-chat scratch space (grammY default
 * `getSessionKey` keys by chat id); the conversations plugin stores its own
 * state under the same session.
 */
import type { Context, SessionFlavor } from "grammy";
import type { ConversationFlavor, Conversation } from "@grammyjs/conversations";
import { config } from "@app/core/config";

/** Plain snapshot of the DB user, mirroring decorators.registered_user. */
export interface DbUserSnap {
  id: number;
  telegramId: string;
  role: string;
  language: string;
  referralCode: string;
  walletBalance: string;
}

export interface SessionData {
  /** Active UI language ("en"/"id"), lowercased. Mirrors User.language. */
  lang: string;
  /** Cached DB user snapshot (refreshed by the registeredUser middleware). */
  dbUser?: DbUserSnap;
  /** Last menu/admin message ids for in-place edits (chat.ts). */
  menuMsgId?: number;
  adminMsgId?: number;
  /** Message id of the QR code photo sent alongside payment instructions. */
  qrMsgId?: number;
  /** Set while waiting for a free-text quantity reply (browse flow). */
  awaitingQtyProductId?: number;
  /** Transient scratch for multi-step flows (mirrors context.user_data extras). */
  scratch: Record<string, unknown>;
}

type BaseContext = Context & SessionFlavor<SessionData>;
// ConversationFlavor gives us `ctx.conversation`, but its session typing treats
// any SessionFlavor as possibly-lazy (MaybePromise). Strip its `session` and
// re-assert the concrete SessionData so `ctx.session.x` stays synchronous.
export type MyContext = Omit<ConversationFlavor<BaseContext>, "session"> &
  SessionFlavor<SessionData>;
export type MyConversation = Conversation<MyContext>;

export function initialSession(): SessionData {
  return { lang: config.DEFAULT_LANGUAGE, scratch: {} };
}
