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

/**
 * Customer navigation state. Bookkeeping/observability only — control flow stays
 * the callback router (callbacks.ts); each screen-rendering handler stamps the
 * state it lands on so the active screen is inspectable/loggable. Names mirror
 * the single-bubble UX spec (botui.txt).
 */
export enum BotState {
  HOME,
  PRODUCT_LIST,
  PRODUCT_DETAIL,
  ORDER_SUMMARY,
  WAIT_PAYMENT,
  PAYMENT_SUCCESS,
  HISTORY,
  HELP,
  BALANCE,
}

export interface SessionData {
  /** Current customer navigation screen (bookkeeping; see {@link BotState}). */
  state: BotState;
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
  awaitingQtyDenomId?: number;
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
  return { state: BotState.HOME, lang: config.DEFAULT_LANGUAGE, scratch: {} };
}
