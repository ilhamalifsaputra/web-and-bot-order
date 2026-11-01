import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SupportUploadPicker, type SupportUploadOptionsState } from "./SupportUploadPicker";
import type { useSupportUploads } from "@/lib/supportUploads";

afterEach(cleanup);

function fakeUploads(): ReturnType<typeof useSupportUploads> {
  return {
    files: [], limits: { imageBytes: 5 * 1024 ** 2, videoBytes: 20 * 1024 ** 2 },
    add: vi.fn(), remove: vi.fn(), retry: vi.fn(), reset: vi.fn(), ids: [], busy: false, failed: false,
  } as ReturnType<typeof useSupportUploads>;
}
function setup(optionsState: SupportUploadOptionsState) {
  const uploads = fakeUploads();
  const onRetryOptions = vi.fn();
  render(<SupportUploadPicker uploads={uploads} optionsState={optionsState} onRetryOptions={onRetryOptions} disabled={false} />);
  return { uploads, onRetryOptions };
}
const fileInput = () => document.querySelector("input[type=file]") as HTMLInputElement | null;

describe("SupportUploadPicker options states", () => {
  it("passes a chosen image and an MP4 through the file input", () => {
    const { uploads } = setup("enabled");
    const image = new File(["x"], "shot.png", { type: "image/png" });
    const video = new File(["y"], "clip.mp4", { type: "video/mp4" });
    expect(fileInput()).toHaveAttribute("accept", "image/jpeg,image/png,image/webp,video/mp4");
    fireEvent.change(fileInput()!, { target: { files: [image, video] } });
    expect(uploads.add).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploads.add).mock.calls[0]![0]).toEqual([image, video]);
  });
  it("shows a loading message and no file input while the options load", () => {
    setup("loading");
    expect(screen.getByText("Checking attachments…")).toBeInTheDocument();
    expect(fileInput()).toBeNull();
  });
  it("shows a Retry that refetches when the options request failed, not the R2 setup text", () => {
    const { onRetryOptions } = setup("error");
    expect(screen.queryByText(/Configure private R2/)).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not check whether attachments are available.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryOptions).toHaveBeenCalledTimes(1);
    expect(fileInput()).toBeNull();
  });
  it("keeps the configuration text only for truly disabled uploads", () => {
    setup("disabled");
    expect(screen.getByText("Attachments unavailable. Configure private R2 to enable uploads.")).toBeInTheDocument();
    expect(fileInput()).toBeNull();
  });
});
