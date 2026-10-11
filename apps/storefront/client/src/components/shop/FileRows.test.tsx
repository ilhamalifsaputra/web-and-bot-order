import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import AttachmentPicker from "./AttachmentPicker";
import EvidenceUploader from "./EvidenceUploader";

describe.each([AttachmentPicker, EvidenceUploader])("staged file identity: %s", (Picker) => {
  it("supports staged files without crypto.randomUUID on plain HTTP", () => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const files = [new File(["a"], "same.mp4", { type: "video/mp4" }),
        new File(["b"], "same.mp4", { type: "video/mp4" })];
      render(<Picker files={files} onChange={vi.fn()} />);
      expect(screen.getAllByRole("button", { name: /remove attachment/i })).toHaveLength(2);
    } finally {
      if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
      else Reflect.deleteProperty(crypto, "randomUUID");
    }
  });

  it("allocates no ObjectURL during a render whose effects never commit", () => {
    URL.createObjectURL = vi.fn();
    URL.revokeObjectURL = vi.fn();
    renderToString(<Picker files={[new File(["a"], "a.png", { type: "image/png" })]} onChange={vi.fn()} />);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("owns each preview URL until replacement/removal/unmount under StrictMode", () => {
    document.documentElement.lang = "en";
    let nextUrl = 0;
    URL.createObjectURL = vi.fn(() => `blob:preview-${++nextUrl}`);
    URL.revokeObjectURL = vi.fn();
    const first = new File(["a"], "same.png", { type: "image/png" });
    const replacement = new File(["b"], "same.png", { type: "image/png" });
    const video = new File(["v"], "clip.mp4", { type: "video/mp4" });
    const files = [first, video];
    const onChange = vi.fn();
    const view = render(<StrictMode><Picker files={files} onChange={onChange} /></StrictMode>);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:preview-1");
    expect(view.container.querySelector("img")).toHaveAttribute("src", "blob:preview-2");
    view.rerender(<StrictMode><Picker files={files} onChange={onChange} disabled /></StrictMode>);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    // Reordering retained Files reuses their preview instead of allocating again.
    view.rerender(<StrictMode><Picker files={[video, first]} onChange={onChange} /></StrictMode>);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector("img")).toHaveAttribute("src", "blob:preview-2");
    // A newly mounted preview also receives StrictMode's setup/cleanup replay.
    view.rerender(<StrictMode><Picker files={[video, replacement]} onChange={onChange} /></StrictMode>);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(4);
    expect(URL.createObjectURL).toHaveBeenLastCalledWith(replacement);
    expect(view.container.querySelector("img")).toHaveAttribute("src", "blob:preview-4");
    const buttons = screen.getAllByRole("button", { name: /remove attachment/i });
    fireEvent.click(buttons[1]!);
    expect(onChange).toHaveBeenCalledExactlyOnceWith([video]);
    view.rerender(<StrictMode><Picker files={[video]} onChange={onChange} /></StrictMode>);
    expect(view.container.querySelector("img")).toBeNull();
    view.unmount();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(4);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(4);
    for (const url of ["blob:preview-1", "blob:preview-2", "blob:preview-3", "blob:preview-4"]) {
      expect(vi.mocked(URL.revokeObjectURL).mock.calls.filter(([value]) => value === url)).toHaveLength(1);
    }
  });

  it("keeps duplicate-name files distinct and preserves row focus through remove and reorder", () => {
    document.documentElement.lang = "en";
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
    const files = [new File(["a"], "same.mp4", { type: "video/mp4", lastModified: 1 }),
      new File(["b"], "same.mp4", { type: "video/mp4", lastModified: 1 }),
      new File(["c"], "third.mp4", { type: "video/mp4" })];
    const onChange = vi.fn();
    const view = render(<Picker files={files} onChange={onChange} />);
    const buttons = screen.getAllByRole("button", { name: /remove attachment/i });
    const second = buttons[1]!;
    second.focus();
    view.rerender(<Picker files={[files[2]!, files[1]!]} onChange={onChange} />);
    const remaining = screen.getAllByRole("button", { name: /remove attachment/i });
    expect(remaining[1]).toBe(second);
    expect(second).toHaveFocus();
    fireEvent.click(second);
    expect(onChange).toHaveBeenCalledExactlyOnceWith([files[2]]);
  });
});
