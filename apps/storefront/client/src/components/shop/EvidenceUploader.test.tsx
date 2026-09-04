import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EvidenceUploader from "./EvidenceUploader";

// Mirrors MAX_TICKET_ATTACHMENTS from lib/attachmentValidation.ts; kept local so
// this test file does not couple to EvidenceUploader re-exporting it.
const MAX_TICKET_ATTACHMENTS_LOCAL = 3;

function makeFile(name: string, type: string, size = 1024): File {
  const file = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("EvidenceUploader", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    URL.createObjectURL = vi.fn(() => "blob:mock-preview");
    URL.revokeObjectURL = vi.fn();
  });

  it("renders the drop-zone CTA, help text and limits line", () => {
    render(<EvidenceUploader files={[]} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /attach files/i })).toBeInTheDocument();
    expect(
      screen.getByText("Screenshots or short videos can help us resolve your issue faster."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Up to 3 photos or videos • 5 MB per photo • 20 MB per video"),
    ).toBeInTheDocument();
  });

  it("makes the drop-zone a real, keyboard-focusable <button>", () => {
    render(<EvidenceUploader files={[]} onChange={vi.fn()} />);
    const dropzone = screen.getByRole("button", { name: /attach files/i });
    expect(dropzone.tagName).toBe("BUTTON");
    expect(dropzone).not.toBeDisabled();
    dropzone.focus();
    expect(dropzone).toHaveFocus();
  });

  it("picking a valid file adds it and calls onChange", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<EvidenceUploader files={[]} onChange={onChange} />);
    const file = makeFile("photo.png", "image/png");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);
    expect(onChange).toHaveBeenCalledWith([file]);
  });

  it("dropping a file ingests it exactly like a picked file", () => {
    const onChange = vi.fn();
    render(<EvidenceUploader files={[]} onChange={onChange} />);
    const dropzone = screen.getByRole("button", { name: /attach files/i });
    const file = makeFile("shot.png", "image/png");
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    expect(onChange).toHaveBeenCalledWith([file]);
  });

  it("picking a 4th file surfaces the count error via role=alert and never grows past 3", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const existing = [
      makeFile("a.png", "image/png"),
      makeFile("b.png", "image/png"),
      makeFile("c.png", "image/png"),
    ];
    expect(existing.length).toBe(MAX_TICKET_ATTACHMENTS_LOCAL);
    render(<EvidenceUploader files={existing} onChange={onChange} />);
    const fourth = makeFile("d.png", "image/png");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, fourth);
    expect(screen.getByRole("alert")).toHaveTextContent("You can attach up to 3 files.");
    expect(onChange).not.toHaveBeenCalledWith([...existing, fourth]);
  });

  it("disables the drop-zone once the attachment limit is reached", () => {
    const existing = [
      makeFile("a.png", "image/png"),
      makeFile("b.png", "image/png"),
      makeFile("c.png", "image/png"),
    ];
    render(<EvidenceUploader files={existing} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /attach files/i })).toBeDisabled();
  });

  it("removing a staged file via its remove button calls onChange without it", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const staged = [makeFile("photo.png", "image/png"), makeFile("clip.mp4", "video/mp4")];
    render(<EvidenceUploader files={staged} onChange={onChange} />);
    const removeButtons = screen.getAllByRole("button", { name: /remove attachment/i });
    await user.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith([staged[1]]);
  });

  it("renders staged files below the drop-zone (thumbnail name for images, name for videos)", () => {
    const staged = [makeFile("photo.png", "image/png"), makeFile("clip.mp4", "video/mp4")];
    render(<EvidenceUploader files={staged} onChange={vi.fn()} />);
    expect(screen.getByText("photo.png")).toBeInTheDocument();
    expect(screen.getByText("clip.mp4")).toBeInTheDocument();
  });
});
