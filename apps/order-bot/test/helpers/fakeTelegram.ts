/**
 * A recording fake Telegram transport for driving the REAL `buildBot()`
 * middleware chain end to end (Phase 5, game-topup-e2e.test.ts).
 *
 * Installed with `bot.api.config.use(...)` AFTER `buildBot()` has installed
 * `htmlDefaultsTransformer`. grammY composes transformers with
 * `transformers.reduce(concatTransformer, this.call)` (grammy/out/core/client.js
 * `use()`), so the LAST installed transformer is the OUTERMOST: this fake sees
 * every call first, as the handler built it, and never calls `prev`, so the
 * HTML defaults transformer (parse_mode / link preview / custom emoji) never
 * runs. Tests therefore assert on message CONTENT, never on `parse_mode`.
 *
 * The fake keeps a small model of the chat (message id → text/caption +
 * markup) so a test can press a button that is actually on screen: the
 * `callback_data` (and any price-lock nonce inside it) is always read back
 * from what the bot rendered, never written by hand.
 */
import type { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";

export const FAKE_ME = {
  id: 123,
  is_bot: true,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as UserFromGetMe;

export interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

interface ScreenMessage {
  chatId: number;
  messageId: number;
  kind: "text" | "photo";
  text: string;
  inline: InlineButton[][];
}

type Markup = { inline_keyboard?: InlineButton[][]; keyboard?: unknown } | undefined;

/** The methods the message-budget rule counts. */
export const SCREEN_METHODS = [
  "sendMessage",
  "sendPhoto",
  "sendDocument",
  "editMessageText",
  "editMessageCaption",
  "editMessageReplyMarkup",
  "editMessageMedia",
  "deleteMessage",
] as const;

export class FakeTelegram {
  readonly calls: RecordedCall[] = [];
  readonly messages = new Map<number, ScreenMessage>();
  private msgSeq = 5000;
  private updateSeq: number;
  /** Id of the message whose inline keyboard was rendered most recently. */
  private lastInlineMessageId: number | undefined;

  constructor(
    readonly bot: Bot<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    readonly chatId: number,
    readonly user: { id: number; first_name: string; username?: string },
    updateSeqStart: number,
  ) {
    this.updateSeq = updateSeqStart;
    // The real Telegram result shape varies per method; this returns the
    // minimal plausible success shape per method family. `any` is the
    // boundary of that simplification.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bot.api.config.use(async (_prev, method, payload): Promise<any> => this.handle(method, (payload ?? {}) as Record<string, unknown>));
  }

  private handle(method: string, payload: Record<string, unknown>): { ok: true; result: unknown } | { ok: false; error_code: number; description: string } {
    this.calls.push({ method, payload: structuredClone(payload) });
    const chatId = typeof payload.chat_id === "number" ? payload.chat_id : Number(payload.chat_id ?? this.chatId);
    const markup = payload.reply_markup as Markup;
    const asMessage = (id: number) => ({ message_id: id, date: 0, chat: { id: chatId, type: "private" } });

    switch (method) {
      case "sendMessage":
      case "sendPhoto":
      case "sendDocument": {
        const id = ++this.msgSeq;
        this.messages.set(id, {
          chatId,
          messageId: id,
          kind: method === "sendPhoto" ? "photo" : "text",
          text: String(payload.text ?? payload.caption ?? ""),
          inline: markup?.inline_keyboard ?? [],
        });
        if (markup?.inline_keyboard) this.lastInlineMessageId = id;
        return { ok: true, result: { ...asMessage(id), text: payload.text, caption: payload.caption } };
      }
      case "editMessageText":
      case "editMessageCaption":
      case "editMessageReplyMarkup": {
        const id = Number(payload.message_id);
        const msg = this.messages.get(id);
        // Reject like Telegram: grammY turns { ok: false } into a GrammyError.
        if (!msg) return { ok: false, error_code: 400, description: "Bad Request: message to edit not found" };
        if (method === "editMessageText" && msg.kind === "photo") {
          return { ok: false, error_code: 400, description: "Bad Request: there is no text in the message to edit" };
        }
        if (method === "editMessageText") msg.text = String(payload.text ?? "");
        if (method === "editMessageCaption") msg.text = String(payload.caption ?? "");
        msg.inline = markup?.inline_keyboard ?? [];
        this.messages.set(id, msg);
        if (markup?.inline_keyboard) this.lastInlineMessageId = id;
        return { ok: true, result: { ...asMessage(id), text: msg.text } };
      }
      case "deleteMessage":
        this.messages.delete(Number(payload.message_id));
        return { ok: true, result: true };
      case "getChatMember":
        return { ok: true, result: { status: "member", user: { id: this.user.id, is_bot: false, first_name: this.user.first_name } } };
      default:
        // answerCallbackQuery, sendChatAction, etc. return a bare boolean.
        return { ok: true, result: true };
    }
  }

  /** Index into `calls` — pass to `since()` to slice one step's calls. */
  mark(): number {
    return this.calls.length;
  }

  since(mark: number): RecordedCall[] {
    return this.calls.slice(mark);
  }

  /** Screen-affecting method names of a step, in order. */
  screen(mark: number): string[] {
    return this.since(mark)
      .map((c) => c.method)
      .filter((m) => (SCREEN_METHODS as readonly string[]).includes(m));
  }

  /** Every chat id any call addressed (for the "never a public channel" check). */
  chatIds(): Set<string> {
    const out = new Set<string>();
    for (const c of this.calls) if (c.payload.chat_id !== undefined) out.add(String(c.payload.chat_id));
    return out;
  }

  /** Text (or caption) of the message holding the most recent inline keyboard. */
  screenText(): string {
    const id = this.lastInlineMessageId;
    return id === undefined ? "" : (this.messages.get(id)?.text ?? "");
  }

  /** Button labels on the most recent inline keyboard. */
  buttons(): InlineButton[] {
    const id = this.lastInlineMessageId;
    return id === undefined ? [] : (this.messages.get(id)?.inline.flat() ?? []);
  }

  /** The current text of a specific message id. */
  textOf(messageId: number): string | undefined {
    return this.messages.get(messageId)?.text;
  }

  /** Find a button on the CURRENT screen. Throws with the visible labels when missing. */
  findButton(match: string | RegExp | ((b: InlineButton) => boolean)): { button: InlineButton; messageId: number } {
    const id = this.lastInlineMessageId;
    const pred =
      typeof match === "function"
        ? match
        : typeof match === "string"
          ? (b: InlineButton) => b.text.includes(match)
          : (b: InlineButton) => match.test(b.text);
    const button = id === undefined ? undefined : this.messages.get(id)?.inline.flat().find(pred);
    if (!button || id === undefined) {
      throw new Error(`No button matching ${String(match)} on the current screen; visible: ${JSON.stringify(this.buttons().map((b) => b.text))}`);
    }
    return { button, messageId: id };
  }

  nextUpdateId(): number {
    return ++this.updateSeq;
  }

  private chat() {
    return { id: this.chatId, type: "private" as const, first_name: this.user.first_name };
  }

  private from() {
    return { id: this.user.id, is_bot: false, first_name: this.user.first_name, username: this.user.username };
  }

  /** Send a text message (a command, a reply-keyboard label, typed input). */
  async sendText(text: string): Promise<void> {
    const update_id = this.nextUpdateId();
    const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0]!.length }] : undefined;
    const message_id = ++this.msgSeq;
    // The buyer's own message exists in the chat model too, so a delete of it
    // (consumeInput) is recorded against a known message.
    this.messages.set(message_id, { chatId: this.chatId, messageId: message_id, kind: "text", text, inline: [] });
    await this.bot.handleUpdate({
      update_id,
      message: { message_id, date: Math.floor(Date.now() / 1000), chat: this.chat(), from: this.from(), text, entities },
    } as unknown as Update);
  }

  /** Tap a callback button for an explicit message (e.g. an OLD keyboard). */
  async tap(messageId: number, data: string): Promise<void> {
    const update_id = this.nextUpdateId();
    const msg = this.messages.get(messageId);
    await this.bot.handleUpdate({
      update_id,
      callback_query: {
        id: `cbq${update_id}`,
        from: this.from(),
        chat_instance: "ci",
        data,
        message: {
          message_id: messageId,
          date: 0,
          chat: this.chat(),
          ...(msg?.kind === "photo" ? { photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }], caption: msg.text } : { text: msg?.text ?? "" }),
        },
      },
    } as unknown as Update);
  }

  /** Tap a label of the most recently sent reply (persistent) keyboard: on
   * Telegram that sends the label as a plain text message. */
  async pressReply(match: RegExp): Promise<string> {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const kb = (this.calls[i]!.payload.reply_markup as { keyboard?: { text: string }[][] } | undefined)?.keyboard;
      if (!kb) continue;
      const label = kb.flat().find((b) => match.test(b.text))?.text;
      if (!label) throw new Error(`No reply-keyboard label matching ${String(match)}; visible: ${JSON.stringify(kb.flat().map((b) => b.text))}`);
      await this.sendText(label);
      return label;
    }
    throw new Error("No reply keyboard was sent yet");
  }

  /** Press a button found on the current screen; returns what was pressed. */
  async press(match: string | RegExp | ((b: InlineButton) => boolean)): Promise<{ data: string; messageId: number }> {
    const { button, messageId } = this.findButton(match);
    if (!button.callback_data) throw new Error(`Button "${button.text}" has no callback_data`);
    await this.tap(messageId, button.callback_data);
    return { data: button.callback_data, messageId };
  }
}
