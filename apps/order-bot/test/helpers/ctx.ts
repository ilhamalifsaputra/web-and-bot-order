/**
 * Test doubles for the bot's grammY surface.
 *
 * `makeCtx` builds a fake MyContext that records every outgoing Telegram call
 * into a shared `sink` (so assertions can inspect what the bot tried to send)
 * and returns plausible results. `FakeConversation` implements the subset of
 * the @grammyjs/conversations handle our conversations use (wait / waitFor /
 * external), feeding scripted update contexts — this exercises the real
 * conversation flow + DB effects without the replay runtime.
 */
import { GrammyError, InputFile } from "grammy";
import type { MyContext, MyConversation, SessionData } from "../../src/context";

/** Mirrors the real Telegram "Bad Request: message is not modified" error
 * grammY throws when an edit's text/caption + reply_markup are identical to
 * what the message already shows. */
function notModifiedError(method: string): GrammyError {
  return new GrammyError(
    `Call to '${method}' failed!`,
    { ok: false, error_code: 400, description: "Bad Request: message is not modified" },
    method,
    {},
  );
}

export interface SentCall {
  method: string;
  args: unknown[];
}

export interface MakeCtxOptions {
  sink?: SentCall[];
  session?: Partial<SessionData>;
  /** Reuse this exact session object instead of building a fresh one, so a
   * whole scripted conversation shares ONE session. That is what really
   * happens: every update for a chat resolves to the same grammY session
   * object, and @grammyjs/conversations hands the live context — hence that
   * live session — to whichever wait() resumed the turn. Without this, each
   * scripted update gets a private session and cross-turn state (menuMsgId,
   * scratch) is unobservable, which is what let a cross-wait anchor bug hide
   * from the suite. Takes precedence over `session`. */
  sharedSession?: SessionData;
  /** Message ids that behave as already-deleted for THIS ctx: any edit
   * targeting them rejects the way real Telegram does ("message to edit not
   * found"). Lets a test drive smartEdit's and editAnchor's fresh-send
   * fallback without first scripting a deleteMessage call. */
  deletedMessageIds?: number[];
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
  /** Sets ctx.callbackQuery with this data. */
  callbackData?: string;
  /** callbackQuery.message (defaults to a plain text message bubble). */
  cbMessage?: Record<string, unknown>;
  /** Sets ctx.message.text. */
  text?: string;
  /** Sets ctx.message.photo. */
  photo?: Array<{ file_id: string }>;
  /** Sets ctx.message.document. */
  document?: { file_id: string; file_name?: string; file_size?: number };
  /** Extra fields merged into ctx.message (e.g. `entities`, `reply_to_message`). */
  messageExtra?: Record<string, unknown>;
  /** ctx.match (command args / regex match). */
  match?: string;
  /** Extra fields merged into replyWithPhoto's resolved Message (e.g. `photo`). */
  replyWithPhotoResult?: Record<string, unknown>;
  /** Make ctx-level editMessageText/editMessageCaption reject with Telegram's
   * real "message is not modified" error, as if the render produced content
   * identical to what the tapped bubble already shows. */
  editThrowsNotModified?: boolean;
  /** Opt-in: make a SECOND ctx.answerCallbackQuery() call for this ctx reject
   * with Telegram's real "query is too old / query id is invalid" error, the
   * way a live bot actually behaves when something tries to answer the same
   * callback query twice. Off by default (answerCallbackQuery always
   * resolves) so this doesn't change behavior for the ~1700 existing call
   * sites that don't opt in — only set this when a test specifically needs
   * to prove a handler doesn't double-answer. */
  rejectDuplicateAnswerCallbackQuery?: boolean;
}

export interface FakeCtx {
  ctx: MyContext;
  sink: SentCall[];
}

const DEFAULT_FROM = { id: 42, username: "tester", first_name: "Test", last_name: "User" };

let msgSeq = 1000;

export function makeCtx(opts: MakeCtxOptions = {}): FakeCtx {
  const sink = opts.sink ?? [];
  const from = { ...DEFAULT_FROM, ...opts.from };
  const chat = { id: from.id, type: "private" as const };

  // Message ids deleted via deleteMessage in THIS ctx. Mirrors real Telegram:
  // editing a deleted message throws, which is what makes smartEdit's catch
  // fall through to a fresh send instead of "successfully" editing a bubble
  // that no longer exists.
  const deletedIds = new Set<number>(opts.deletedMessageIds ?? []);

  // A raw grammY InputFile can't be JSON.stringify'd (its toJSON throws
  // "must be sent via grammY"), which would blow up sentIncludes the moment a
  // sendDocument lands in the sink. Store a serialization-safe stand-in that
  // still exposes .filename so assertions can check the delivered file.
  const sanitize = (args: unknown[]): unknown[] =>
    args.map((a) => (a instanceof InputFile ? { __inputFile: true, filename: a.filename } : a));

  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      sink.push({ method, args: sanitize(args) });
      return Promise.resolve({ message_id: ++msgSeq, chat, date: 0 });
    };

  const recDelete =
    (method: string) =>
    (...args: unknown[]) => {
      sink.push({ method, args });
      const messageId = args[1] as number | undefined;
      if (typeof messageId === "number") deletedIds.add(messageId);
      return Promise.resolve(true);
    };

  // ctx-level editors implicitly target ctx.callbackQuery.message — used by
  // smartEdit/adminEdit. If that message id was deleted in this ctx, behave
  // like real Telegram ("message to edit not found") so callers' fallback
  // logic (fresh send) actually gets exercised instead of silently "succeeding".
  const recCtxEdit =
    (method: string) =>
    (...args: unknown[]) => {
      const cqMsgId = (callbackQuery?.message as { message_id?: number } | undefined)?.message_id;
      if (cqMsgId !== undefined && deletedIds.has(cqMsgId)) {
        return Promise.reject(new Error("message to edit not found"));
      }
      if (opts.editThrowsNotModified) {
        return Promise.reject(notModifiedError(method));
      }
      sink.push({ method, args });
      return Promise.resolve({ message_id: ++msgSeq, chat, date: 0 });
    };

  // api-level editors take an explicit (chatId, messageId, …) — unlike the
  // ctx-level ones they don't depend on a callback query, so this is the path
  // wizard anchors use. Reject when the target bubble is gone, the way real
  // Telegram does, so editAnchor's fresh-send fallback is reachable from a
  // test. editMessageReplyMarkup deliberately stays on the plain recorder:
  // retireKeyboard swallows its errors anyway, and keeping it recorded lets
  // tests still observe that a stale bubble's keyboard was retired.
  const recApiEdit =
    (method: string) =>
    (...args: unknown[]) => {
      const messageId = args[1];
      if (typeof messageId === "number" && deletedIds.has(messageId)) {
        return Promise.reject(new Error("message to edit not found"));
      }
      sink.push({ method, args: sanitize(args) });
      return Promise.resolve({ message_id: ++msgSeq, chat, date: 0 });
    };

  const api = {
    sendMessage: rec("sendMessage"),
    sendPhoto: rec("sendPhoto"),
    sendDocument: rec("sendDocument"),
    sendMediaGroup: rec("sendMediaGroup"),
    editMessageText: recApiEdit("editMessageText"),
    editMessageCaption: recApiEdit("editMessageCaption"),
    editMessageReplyMarkup: rec("editMessageReplyMarkup"),
    deleteMessage: recDelete("deleteMessage"),
    setMyCommands: rec("setMyCommands"),
    deleteWebhook: rec("deleteWebhook"),
    getFile: (..._a: unknown[]) => Promise.resolve({ file_id: "f", file_path: "docs/file.txt" }),
  };

  const message =
    opts.text !== undefined || opts.photo || opts.document
      ? {
          message_id: ++msgSeq,
          chat,
          from,
          date: 0,
          text: opts.text,
          photo: opts.photo,
          document: opts.document,
          ...opts.messageExtra,
        }
      : undefined;

  // Tracks whether THIS ctx's callback query has already been answered, for
  // the opt-in rejectDuplicateAnswerCallbackQuery behavior below.
  let callbackQueryAnswered = false;
  const answerCallbackQuery = opts.rejectDuplicateAnswerCallbackQuery
    ? (...args: unknown[]) => {
        if (callbackQueryAnswered) {
          return Promise.reject(
            new GrammyError(
              "Call to 'answerCallbackQuery' failed!",
              {
                ok: false,
                error_code: 400,
                description: "Bad Request: query is too old and response timeout expired or query id is invalid",
              },
              "answerCallbackQuery",
              {},
            ),
          );
        }
        callbackQueryAnswered = true;
        sink.push({ method: "answerCallbackQuery", args });
        return Promise.resolve(true);
      }
    : rec("answerCallbackQuery");

  const callbackQuery = opts.callbackData
    ? {
        id: "cb-" + ++msgSeq,
        from,
        chat_instance: "ci",
        data: opts.callbackData,
        message: opts.cbMessage ?? { message_id: ++msgSeq, chat, date: 0 },
      }
    : undefined;

  const session: SessionData =
    opts.sharedSession ??
    ({
      lang: "en",
      scratch: {},
      ...opts.session,
    } as SessionData);

  const ctx = {
    update: { update_id: ++msgSeq },
    api,
    from,
    chat,
    chatId: chat.id,
    message,
    callbackQuery,
    match: opts.match,
    session,
    reply: rec("reply"),
    replyWithPhoto: opts.replyWithPhotoResult
      ? (...args: unknown[]) => {
          sink.push({ method: "replyWithPhoto", args });
          return Promise.resolve({ message_id: ++msgSeq, chat, date: 0, ...opts.replyWithPhotoResult });
        }
      : rec("replyWithPhoto"),
    replyWithDocument: rec("replyWithDocument"),
    editMessageText: recCtxEdit("editMessageText"),
    editMessageCaption: recCtxEdit("editMessageCaption"),
    editMessageReplyMarkup: rec("editMessageReplyMarkup"),
    answerCallbackQuery,
    // Real grammY's ConversationFlavor — only .enter() is exercised outside
    // the conversations() middleware today (checkout.ts's showOrderConfirmation
    // calls it directly for the manual_with_info gate). Recorded into the sink
    // like every other outgoing call so a test can assert which conversation a
    // handler tried to enter without actually running its replay machinery.
    conversation: { enter: rec("conversation.enter") },
  } as unknown as MyContext;

  return { ctx, sink };
}

/** A conversation handle stub feeding queued contexts; external() runs ops now.
 *
 * A queue entry may be a ready-made context or a thunk built at wait() time.
 * Thunks exist because a realistic tap has to reference state the conversation
 * hasn't produced yet: the wizard's buttons live ON the anchor bubble, so a
 * tap's callbackQuery.message.message_id must equal the anchor id — which only
 * exists once the earlier step has rendered. */
export class FakeConversation {
  constructor(private readonly queue: Array<MyContext | (() => MyContext)>) {}

  async wait(): Promise<MyContext> {
    const c = this.queue.shift();
    if (!c) throw new Error("FakeConversation: queue empty (conversation waited for more input than scripted)");
    return typeof c === "function" ? c() : c;
  }
  waitFor = (_q?: unknown) => this.wait();
  waitForHears = (_t?: unknown) => this.wait();
  waitUntil = (_p?: unknown) => this.wait();

  async external<T>(op: (() => T | Promise<T>) | { task: () => T | Promise<T> }): Promise<T> {
    const fn = typeof op === "function" ? op : op.task;
    return await fn();
  }

  asMyConversation(): MyConversation {
    return this as unknown as MyConversation;
  }
}

/** Find the calls of a given method in the sink. */
export function calls(sink: SentCall[], method: string): SentCall[] {
  return sink.filter((c) => c.method === method);
}

/** True if any recorded call's stringified args contain `needle`. */
export function sentIncludes(sink: SentCall[], needle: string): boolean {
  return sink.some((c) => JSON.stringify(c.args).includes(needle));
}

/** The reply_markup of the most recent screen-producing call, if any. */
export function lastMarkup(sink: SentCall[]): { inline_keyboard?: unknown[][] } | undefined {
  const screens = ["editMessageText", "editMessageCaption", "reply", "sendMessage", "replyWithPhoto"];
  for (let i = sink.length - 1; i >= 0; i--) {
    const c = sink[i]!;
    if (screens.includes(c.method)) {
      const opts = c.args[c.args.length - 1] as { reply_markup?: { inline_keyboard?: unknown[][] } } | undefined;
      if (opts && typeof opts === "object" && "reply_markup" in opts) return opts.reply_markup;
    }
  }
  return undefined;
}

/** True if the latest screen offers ≥1 inline button (a forward action, never stranding the user). */
export function offersForwardAction(sink: SentCall[]): boolean {
  const m = lastMarkup(sink);
  return !!m && Array.isArray(m.inline_keyboard) && m.inline_keyboard.flat().length > 0;
}
