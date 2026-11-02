import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import SupportUploadPicker from "./SupportUploadPicker";
import type { SupportUpload } from "../../lib/supportUploads";

vi.mock("./SupportFilePreview", () => ({ SupportFilePreview: () => null }));

function uploadsWith(file: Partial<SupportUpload>) {
  const row: SupportUpload = { key: "k1", file: new File(["x"], "proof.png", { type: "image/png" }), progress: 0, state: "uploading", ...file };
  return {
    files: [row],
    limits: { imageBytes: 5 * 1024 ** 2, videoBytes: 20 * 1024 ** 2 },
    add: vi.fn(), retry: vi.fn(), remove: vi.fn(),
    busy: true, failed: false, ids: [],
  } as unknown as Parameters<typeof SupportUploadPicker>[0]["uploads"];
}

describe("SupportUploadPicker upload progress", () => {
  it("shows a real percentage and bar once the browser reports progress", () => {
    render(<SupportUploadPicker uploads={uploadsWith({ progress: 40 })} />);
    expect(screen.getByText(/40%/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "proof.png" })).toHaveAttribute("value", "40");
  });

  it("shows no made-up 0% before any progress is measured, only an indeterminate spinner", () => {
    const { container } = render(<SupportUploadPicker uploads={uploadsWith({ progress: 0 })} />);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(container.querySelector("span[aria-hidden='true'].rounded-full")).toBeInTheDocument();
  });
});

describe("SupportUploadPicker file state icons", () => {
  it("an uploading file shows a hidden cloud-upload icon", () => {
    const { container } = render(<SupportUploadPicker uploads={uploadsWith({ progress: 40 })} />);
    expect(container.querySelector("svg.lucide-cloud-upload")).toHaveAttribute("aria-hidden", "true");
  });

  it("an uploaded file shows a hidden file-check icon beside its words", () => {
    const { container } = render(<SupportUploadPicker uploads={uploadsWith({ state: "ready", progress: 100, id: "a1" })} />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(container.querySelector("svg.lucide-file-check")).toHaveAttribute("aria-hidden", "true");
  });

  it("a failed file shows a hidden file-x icon and its reason in the destructive tone", () => {
    const { container } = render(<SupportUploadPicker uploads={uploadsWith({ state: "failed", error: "Upload blocked" })} />);
    expect(container.querySelector("svg.lucide-file-x")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Upload blocked");
    expect(screen.getByRole("alert")).toHaveClass("text-rust-dark");
  });
});
