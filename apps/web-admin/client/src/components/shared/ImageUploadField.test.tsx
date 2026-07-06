import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImageUploadField } from "./ImageUploadField";

const FILE = new File(["fake-bytes"], "photo.png", { type: "image/png" });

beforeEach(() => {
  vi.restoreAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:mock-preview");
  URL.revokeObjectURL = vi.fn();
});

function renderField(overrides: Partial<React.ComponentProps<typeof ImageUploadField>> = {}) {
  const onUploaded = vi.fn();
  render(
    <ImageUploadField
      label="Product photo"
      imageUrl=""
      uploadPath="/catalog/product/1/photo"
      fieldName="photo"
      accept=".png"
      onUploaded={onUploaded}
      {...overrides}
    />,
  );
  return { onUploaded };
}

async function pickFile() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const user = userEvent.setup();
  await user.upload(input, FILE);
  return user;
}

describe("ImageUploadField", () => {
  it("shows a preview plus Save/Cancel after picking a file, without uploading", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderField();
    await pickFile();
    expect(screen.getByRole("img", { name: "Product photo" })).toHaveAttribute("src", "blob:mock-preview");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Cancel discards the pick and reverts to the prior display", async () => {
    renderField({ imageUrl: "/uploads/products/existing.png" });
    const user = await pickFile();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Product photo" })).toHaveAttribute(
      "src",
      "/uploads/products/existing.png",
    );
  });

  it("Save uploads the picked file and calls onUploaded with the saved URL on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ url: "/uploads/products/product-abc123.png" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { onUploaded } = renderField();
    const user = await pickFile();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("/uploads/products/product-abc123.png"));
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/catalog/product/1/photo");
    const body = init!.body as FormData;
    expect(body.get("photo")).toBe(FILE);
    expect(body.has("csrf_token")).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("shows the server error and keeps the pending file when Save fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("That file type is not allowed.", { status: 400 }),
    );
    const { onUploaded } = renderField();
    const user = await pickFile();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("That file type is not allowed.")).toBeInTheDocument());
    expect(onUploaded).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});
