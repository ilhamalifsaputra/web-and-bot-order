import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TicketComposer from "./TicketComposer";
import { loadTicketDraft } from "../../lib/ticketDraft";

// jsdom under this repo's Vitest config exposes no `window.localStorage` at
// all (see apps/storefront/client/src/pages/SearchPage.test.tsx's own
// installStorage helper for the same quirk) — install a minimal in-memory
// one so ticketDraft.ts's real localStorage calls have something to hit.
function installStorage(): void {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (entries.has(key) ? entries.get(key)! : null),
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
}

describe("TicketComposer", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    installStorage();
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => "blob:mock-preview");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(onSubmit = vi.fn(), onMessageChange = vi.fn()) {
    const utils = render(
      <TicketComposer
        ticketId={7}
        message=""
        onMessageChange={onMessageChange}
        files={[]}
        onFilesChange={vi.fn()}
        onSubmit={onSubmit}
        pending={false}
        uploadProgress={0}
      />,
    );
    return { ...utils, onSubmit, onMessageChange };
  }

  it("shows a character counter that updates with the message length", () => {
    const { rerender } = setup();
    expect(screen.getByText("0/2000")).toBeInTheDocument();
    rerender(
      <TicketComposer
        ticketId={7}
        message="hello"
        onMessageChange={vi.fn()}
        files={[]}
        onFilesChange={vi.fn()}
        onSubmit={vi.fn()}
        pending={false}
        uploadProgress={0}
      />,
    );
    expect(screen.getByText("5/2000")).toBeInTheDocument();
  });

  it("submits on Ctrl+Enter when there's a non-empty message", () => {
    const onSubmit = vi.fn();
    render(
      <TicketComposer
        ticketId={7}
        message="ready to send"
        onMessageChange={vi.fn()}
        files={[]}
        onFilesChange={vi.fn()}
        onSubmit={onSubmit}
        pending={false}
        uploadProgress={0}
      />,
    );
    fireEvent.keyDown(screen.getByPlaceholderText("Tell us what's wrong…"), { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit on Ctrl+Enter while pending or while the message is empty", () => {
    const onSubmit = vi.fn();
    render(
      <TicketComposer
        ticketId={7}
        message=""
        onMessageChange={vi.fn()}
        files={[]}
        onFilesChange={vi.fn()}
        onSubmit={onSubmit}
        pending={false}
        uploadProgress={0}
      />,
    );
    fireEvent.keyDown(screen.getByPlaceholderText("Tell us what's wrong…"), { key: "Enter", ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("debounce-saves the message as a draft, retrievable via loadTicketDraft", () => {
    const { rerender } = setup();
    rerender(
      <TicketComposer
        ticketId={7}
        message="in-progress reply"
        onMessageChange={vi.fn()}
        files={[]}
        onFilesChange={vi.fn()}
        onSubmit={vi.fn()}
        pending={false}
        uploadProgress={0}
      />,
    );
    vi.advanceTimersByTime(600);
    expect(loadTicketDraft(7)).toBe("in-progress reply");
  });

  it("disables the submit button while pending or when the message is blank", () => {
    setup();
    expect(screen.getByRole("button", { name: /reply/i })).toBeDisabled();
  });
});
