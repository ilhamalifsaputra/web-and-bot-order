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
import { GrammyError } from "grammy";
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
  /** ctx.match (command args / regex match). */
  match?: string;
  /** Extra fields merged into replyWithPhoto's resolved Message (e.g. `photo`). */
  replyWithPhotoResult?: Record<string, unknown>;
  /** Make ctx-level editMessageText/editMessageCaption reject with Telegram's
   * real "message is not modified" error, as if the render produced content
   * identical to what the tapped bubble already shows. */
  editThrowsNotModified?: boolean;
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
  const deletedIds = new Set<number>();

  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      sink.push({ method, args });
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

  const api = {
    sendMessage: rec("sendMessage"),
    sendPhoto: rec("sendPhoto"),
    sendDocument: rec("sendDocument"),
    sendMediaGroup: rec("sendMediaGroup"),
    editMessageText: rec("editMessageText"),
    editMessageCaption: rec("editMessageCaption"),
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
        }
      : undefined;

  const callbackQuery = opts.callbackData
    ? {
        id: "cb-" + ++msgSeq,
        from,
        chat_instance: "ci",
        data: opts.callbackData,
        message: opts.cbMessage ?? { message_id: ++msgSeq, chat, date: 0 },
      }
    : undefined;

  const session: SessionData = {
    lang: "en",
    scratch: {},
    ...opts.session,
  } as SessionData;

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
    answerCallbackQuery: rec("answerCallbackQuery"),
  } as unknown as MyContext;

  return { ctx, sink };
}

/** A conversation handle stub feeding queued contexts; external() runs ops now. */
export class FakeConversation {
  constructor(private readonly queue: MyContext[]) {}

  async wait(): Promise<MyContext> {
    const c = this.queue.shift();
    if (!c) throw new Error("FakeConversation: queue empty (conversation waited for more input than scripted)");
    return c;
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
