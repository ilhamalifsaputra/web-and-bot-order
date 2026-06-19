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
import type { MyContext, MyConversation, SessionData } from "../../src/context";

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

  const rec =
    (method: string) =>
    (...args: unknown[]) => {
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
    deleteMessage: rec("deleteMessage"),
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
    editMessageText: rec("editMessageText"),
    editMessageCaption: rec("editMessageCaption"),
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
