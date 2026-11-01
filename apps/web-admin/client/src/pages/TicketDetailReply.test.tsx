import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TicketDetailReply } from "./TicketDetailPage";
import type { useSupportUploads } from "@/lib/supportUploads";

afterEach(cleanup);

function renderReply(uploads: Partial<ReturnType<typeof useSupportUploads>>, reply = "Draft answer") {
  const all = { files: [], limits: { imageBytes: 5 * 1024 ** 2, videoBytes: 20 * 1024 ** 2 }, add: vi.fn(), remove: vi.fn(), retry: vi.fn(), reset: vi.fn(), ids: [], busy: false, failed: false, ...uploads } as ReturnType<typeof useSupportUploads>;
  const sendReply = { mutate: vi.fn(), isPending: false } as never;
  render(<TicketDetailReply uploads={all} optionsState="enabled" onRetryOptions={vi.fn()} replyError={null} reply={reply} setReply={vi.fn()} internal={false} setInternal={vi.fn()} sendReply={sendReply} />);
}
const REASON = "Remove or retry the failed file to send.";

describe("TicketDetailReply failed-file blocking", () => {
  it("says why Send is disabled while a file has failed, and keeps the draft", () => {
    renderReply({ busy: true, failed: true, files: [{ key: "k", file: new File(["x"], "a.png", { type: "image/png" }), progress: 0, state: "failed", error: "Upload failed." }] });
    expect(screen.getByText(REASON)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send reply/i })).toBeDisabled();
    expect(screen.getByLabelText("Reply")).toHaveValue("Draft answer");
    expect(screen.getByText("a.png")).toBeInTheDocument();
  });
  it("shows no reason when nothing failed, even while a file is uploading", () => {
    renderReply({ busy: true, failed: false });
    expect(screen.queryByText(REASON)).toBeNull();
  });
  it("enables Send with no reason when every file is ready", () => {
    renderReply({ ids: ["id-1"] });
    expect(screen.queryByText(REASON)).toBeNull();
    expect(screen.getByRole("button", { name: /send reply/i })).toBeEnabled();
  });
});
