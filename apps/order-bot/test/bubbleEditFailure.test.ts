/**
 * Direct unit test for the anchored-payment-bubble failure classifier.
 *
 * Six call sites depend on this one judgement (the three crypto deposit
 * rails, the two QRIS reconcile rails, and the generic paid-order bubble
 * sweep), but until this file existed it was only ever exercised THROUGH
 * them — so its subtlest decision, that "there is no text/caption in the
 * message to edit" is deliberately NOT permanent, had no test of its own and
 * could have been reversed without a single suite turning red. That reversal
 * would let a rail which only ever calls `editMessageText` throw away an
 * anchor the generic sweeper could still have fixed by editing the caption
 * instead, stranding the buyer on a stale payment QR for an order that is
 * already paid and delivered.
 */
import { describe, expect, it } from "vitest";
import { isPermanentBubbleEditFailure } from "../src/util/bubbleEditFailure";
import { telegramError } from "./helpers/ctx";

describe("isPermanentBubbleEditFailure", () => {
  // Every fragment on the permanent list, each written the way Telegram
  // actually words it (explanatory tails and all) so the substring matching
  // is proven, not just the bare fragment.
  it.each([
    ["Bad Request: message is not modified: specified new message content and reply markup are exactly the same"],
    ["Bad Request: message to edit not found"],
    ["Bad Request: message can't be edited"],
    ["Bad Request: MESSAGE_ID_INVALID"],
    ["Bad Request: chat not found"],
    ["Forbidden: bot was blocked by the user"],
    ["Forbidden: user is deactivated"],
    ["Forbidden: bot was kicked from the group chat"],
  ])("treats %s as permanent, so the caller may stop retrying and drop the anchor", (description) => {
    expect(isPermanentBubbleEditFailure(telegramError(400, description))).toBe(true);
  });

  // The two deliberate exclusions. Both mean "you used the wrong edit method
  // for this bubble's shape", not "this bubble is dead" — `editPaymentBubble`
  // (jobs/index.ts) recovers from exactly that by trying the other method, so
  // calling either permanent would throw away a still-fixable bubble.
  it.each([
    ["Bad Request: there is no text in the message to edit"],
    ["Bad Request: there is no caption in the message to edit"],
  ])("never treats %s as permanent — it names the wrong edit method, not a dead bubble", (description) => {
    expect(isPermanentBubbleEditFailure(telegramError(400, description))).toBe(false);
  });

  it.each([
    ["Telegram flood control", telegramError(429, "Too Many Requests: retry after 30")],
    ["a Telegram server error", telegramError(502, "Bad Gateway")],
  ])("treats %s as transient, because the very same edit can succeed a minute later", (_label, error) => {
    expect(isPermanentBubbleEditFailure(error)).toBe(false);
  });

  it("treats anything that is not a Telegram API error as transient, because the request may never have reached Telegram", () => {
    expect(isPermanentBubbleEditFailure(new Error("socket hang up"))).toBe(false);
    expect(isPermanentBubbleEditFailure("message to edit not found")).toBe(false);
    expect(isPermanentBubbleEditFailure(null)).toBe(false);
    expect(isPermanentBubbleEditFailure(undefined)).toBe(false);
  });
});
