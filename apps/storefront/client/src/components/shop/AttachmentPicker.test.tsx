import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AttachmentPicker, { MAX_TICKET_ATTACHMENTS } from "./AttachmentPicker";

function makeFile(name: string, type: string, size = 1024): File {
  const file = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("AttachmentPicker", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    URL.createObjectURL = vi.fn(() => "blob:mock-preview");
    URL.revokeObjectURL = vi.fn();
  });

  it('renders the "Attach evidence" trigger', () => {
    render(<AttachmentPicker files={[]} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /attach evidence/i })).toBeInTheDocument();
  });

  it("picking a valid file adds it to the list and calls onChange", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AttachmentPicker files={[]} onChange={onChange} />);
    const file = makeFile("photo.png", "image/png");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);
    expect(onChange).toHaveBeenCalledWith([file]);
  });

  it("picking a 4th file surfaces the count error and does not call onChange with 4 files", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const existing = [
      makeFile("a.png", "image/png"),
      makeFile("b.png", "image/png"),
      makeFile("c.png", "image/png"),
    ];
    expect(existing.length).toBe(MAX_TICKET_ATTACHMENTS);
    render(<AttachmentPicker files={existing} onChange={onChange} />);
    const fourth = makeFile("d.png", "image/png");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, fourth);
    expect(screen.getByText("You can attach up to 3 files.")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith([...existing, fourth]);
  });

  it("removing a staged file via its remove button calls onChange without it", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const staged = [makeFile("photo.png", "image/png"), makeFile("clip.mp4", "video/mp4")];
    render(<AttachmentPicker files={staged} onChange={onChange} />);
    const removeButtons = screen.getAllByRole("button", { name: /remove attachment/i });
    await user.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith([staged[1]]);
  });
});
