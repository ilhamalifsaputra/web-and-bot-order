import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TicketConversation, type ConversationMessage } from "./TicketConversation";

function msg(over: Partial<ConversationMessage>): ConversationMessage {
  return {
    key: "a",
    sender: "Customer",
    fromAdmin: false,
    internal: false,
    time: "",
    timeTitle: "",
    content: "hello",
    photoIds: [],
    ...over,
  };
}

function renderConv(m: ConversationMessage) {
  render(<TicketConversation messages={[m]} onPreviewPhoto={vi.fn()} composer={null} />);
}

describe("TicketConversation sender line", () => {
  it("omits the separator when the message has no time", () => {
    renderConv(msg({}));
    expect(screen.getByText("Customer").parentElement?.textContent).toBe("Customer");
  });

  it("shows sender and time when there is one", () => {
    renderConv(msg({ time: "01:32" }));
    expect(screen.getByText("Customer").parentElement?.textContent).toBe("Customer · 01:32");
  });
});
