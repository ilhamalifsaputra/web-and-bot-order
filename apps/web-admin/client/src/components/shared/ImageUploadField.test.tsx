import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImageUploadField } from "./ImageUploadField";
import { FakeXHR } from "@/test/fakeXhr";

const FILE = new File(["fake-bytes"], "photo.png", { type: "image/png" });

beforeEach(() => {
  vi.restoreAllMocks();
  FakeXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
  URL.createObjectURL = vi.fn(() => "blob:mock-preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

async function saveAndGetXhr(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
  return FakeXHR.instances[0]!;
}

describe("ImageUploadField", () => {
  it("shows a preview plus Save/Cancel after picking a file, without uploading", async () => {
    renderField();
    await pickFile();
    expect(screen.getByRole("img", { name: "Product photo" })).toHaveAttribute("src", "blob:mock-preview");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(FakeXHR.instances).toHaveLength(0);
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
    const { onUploaded } = renderField();
    const user = await pickFile();
    const xhr = await saveAndGetXhr(user);

    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/catalog/product/1/photo");
    expect(xhr.sentBody?.get("photo")).toBe(FILE);
    expect(xhr.sentBody?.has("csrf_token")).toBe(true);

    xhr.respond(200, JSON.stringify({ url: "/uploads/products/product-abc123.png" }));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("/uploads/products/product-abc123.png"));
    expect(screen.queryByRole("button", { name: /^Save/ })).not.toBeInTheDocument();
  });

  it("shows live upload progress while the request is in flight", async () => {
    renderField();
    const user = await pickFile();
    const xhr = await saveAndGetXhr(user);

    expect(screen.getByRole("button", { name: "Saving…" })).toBeInTheDocument();
    act(() => xhr.progress(50, 100));
    await waitFor(() => expect(screen.getByRole("button", { name: "Saving… 50%" })).toBeInTheDocument());

    xhr.respond(200, JSON.stringify({ url: "/uploads/products/product-abc123.png" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Saving/ })).not.toBeInTheDocument());
  });

  it("shows the server error and keeps the pending file when Save fails", async () => {
    const { onUploaded } = renderField();
    const user = await pickFile();
    const xhr = await saveAndGetXhr(user);
    xhr.respond(400, "That file type is not allowed.");

    await waitFor(() => expect(screen.getByText("That file type is not allowed.")).toBeInTheDocument());
    expect(onUploaded).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("shows a friendly reload message and a working Reload button on a stale-session CSRF failure", async () => {
    const reloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
    const { onUploaded } = renderField();
    const user = await pickFile();
    const xhr = await saveAndGetXhr(user);
    xhr.respond(403, "CSRF check failed");

    await waitFor(() => expect(screen.getByText(/session was refreshed in another tab/i)).toBeInTheDocument());
    expect(onUploaded).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /reload/i }));
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it("shows a brief checkmark after a successful upload when showSuccessCheckmark is set", async () => {
    const { onUploaded } = renderField({ showSuccessCheckmark: true });
    const user = await pickFile();
    const xhr = await saveAndGetXhr(user);
    xhr.respond(200, JSON.stringify({ url: "/uploads/products/product-abc123.png" }));

    await waitFor(() => expect(onUploaded).toHaveBeenCalled());
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();

    await waitFor(() => expect(screen.queryByText("Saved")).not.toBeInTheDocument(), { timeout: 2000 });
  });

  it("does not show a checkmark after upload when showSuccessCheckmark is unset (default)", async () => {
    const { onUploaded } = renderField();
    const user = await pickFile();
    const xhr = await saveAndGetXhr(user);
    xhr.respond(200, JSON.stringify({ url: "/uploads/products/product-abc123.png" }));

    await waitFor(() => expect(onUploaded).toHaveBeenCalled());
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });
});

describe("dropzone variant", () => {
  it("renders the dashed drop-zone with 'Browse image' in the empty state, not the row variant's 'Choose file…'", () => {
    renderField({ variant: "dropzone" });
    expect(screen.getByText("Browse image")).toBeInTheDocument();
    expect(screen.queryByText("Choose file…")).not.toBeInTheDocument();
  });

  it("picking a file still stages a preview and Save uploads it, unaffected by the variant", async () => {
    const { onUploaded } = renderField({ variant: "dropzone" });
    const user = await pickFile();
    const xhr = await saveAndGetXhr(user);
    xhr.respond(200, JSON.stringify({ url: "/uploads/products/product-abc123.png" }));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("/uploads/products/product-abc123.png"));
  });

  it("shows a Remove image button over a saved image when onRemove is provided, and calls it on click", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    renderField({ variant: "dropzone", imageUrl: "/uploads/x.png", onRemove });
    const removeButton = screen.getByRole("button", { name: "Remove image" });
    await user.click(removeButton);
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("does not render a Remove image button when onRemove is not provided", () => {
    renderField({ variant: "dropzone", imageUrl: "/uploads/x.png" });
    expect(screen.queryByRole("button", { name: "Remove image" })).not.toBeInTheDocument();
  });
});
