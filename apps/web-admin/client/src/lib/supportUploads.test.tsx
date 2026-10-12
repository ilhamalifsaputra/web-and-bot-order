import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiPost } from "../api/client";
import { supportUploadErrorKey, useSupportUploads } from "./supportUploads";
vi.mock("../api/client", () => ({ apiPost: vi.fn() }));

class UploadRequest {
  static instances: UploadRequest[] = [];
  status = 200;
  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  onabort?: () => void;
  constructor() { UploadRequest.instances.push(this); }
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();
  abort = vi.fn(() => this.onabort?.());
}
const photo = () => new File(["photo"], "proof.jpg", { type: "image/jpeg" });
const invalid = () => new File(["<svg/>"], "proof.svg", { type: "image/svg+xml" });
beforeEach(() => { vi.resetAllMocks(); UploadRequest.instances = []; vi.stubGlobal("XMLHttpRequest", UploadRequest); });
afterEach(() => vi.unstubAllGlobals());

describe("support direct uploads", () => {
  it("refuses active content and empty files without sending bytes or allowing retries", () => {
    const { result } = renderHook(() => useSupportUploads());
    act(() => result.current.add([invalid(), new File([], "empty.jpg", { type: "image/jpeg" })]));
    expect(result.current.files.map((file) => file.state)).toEqual(["failed", "failed"]);
    expect(result.current.files[0]!.error).toContain("JPG");
    expect(result.current.files[1]!.error).toContain("5 MB");
    act(() => result.current.retry(result.current.files[0]!));
    expect(apiPost).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(true);
    expect(result.current.ids).toEqual([]);
  });

  it("enforces three files even when two input events arrive before React rerenders", () => {
    const { result } = renderHook(() => useSupportUploads());
    act(() => { result.current.add([invalid(), invalid()]); result.current.add([invalid(), invalid()]); });
    expect(result.current.files).toHaveLength(3);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("shows real progress and blocks submission until the server verifies the file", async () => {
    let verified!: (value: unknown) => void;
    vi.mocked(apiPost).mockResolvedValueOnce({ id: "proof-1", url: "https://storage.invalid/proof", headers: { "Content-Type": "image/jpeg" } })
      .mockImplementationOnce(() => new Promise((resolve) => { verified = resolve; }));
    const { result } = renderHook(() => useSupportUploads(12));
    const file = photo();
    act(() => result.current.add([file]));
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
    const xhr = UploadRequest.instances[0]!;
    expect(xhr.open).toHaveBeenCalledWith("PUT", "https://storage.invalid/proof");
    expect(xhr.send).toHaveBeenCalledWith(file);
    act(() => xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 }));
    expect(result.current.files[0]!.progress).toBe(50);
    act(() => xhr.onload?.());
    await waitFor(() => expect(result.current.files[0]!.state).toBe("verifying"));
    expect(result.current.busy).toBe(true);
    expect(result.current.ids).toEqual([]);
    await act(async () => verified({ ok: true }));
    await waitFor(() => expect(result.current.ids).toEqual(["proof-1"]));
    expect(result.current.busy).toBe(false);
  });

  it("keeps a denied upload out of the message and retries with a fresh intent", async () => {
    vi.mocked(apiPost).mockImplementation(async (path) => {
      if (path.endsWith("/abort") || path.endsWith("/finalize")) return { ok: true };
      const id = UploadRequest.instances.length ? "proof-new" : "proof-old";
      return { id, url: `https://storage.invalid/${id}`, headers: {} };
    });
    const { result } = renderHook(() => useSupportUploads(12));
    act(() => result.current.add([photo()]));
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
    const old = UploadRequest.instances[0]!;
    old.status = 403;
    act(() => old.onload?.());
    await waitFor(() => expect(result.current.files[0]!.state).toBe("failed"));
    expect(result.current.ids).toEqual([]);
    expect(result.current.busy).toBe(true);
    expect(result.current.files[0]!.error).toMatch(/expired|denied/);
    act(() => result.current.retry(result.current.files[0]!));
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(2));
    expect(vi.mocked(apiPost).mock.calls.some(([path]) => path.endsWith("/proof-old/abort"))).toBe(true);
    act(() => UploadRequest.instances[1]!.onload?.());
    await waitFor(() => expect(result.current.ids).toEqual(["proof-new"]));
    expect(result.current.files[0]!.attempts).toBe(2);
  });

  it.each([[403, "upload_denied"], [404, "upload_ticket_unavailable"], [429, "upload_quota"], [503, "upload_server"]])("explains HTTP %s without exposing storage URLs", (status, key) => {
    expect(supportUploadErrorKey(Object.assign(new Error("https://storage.invalid/?secret=redacted"), { status }))).toBe(`helpdesk.${key}`);
  });
  it("never renders an arbitrary upstream error or signed URL", () => {
    expect(supportUploadErrorKey(new Error("https://storage.invalid/?secret=redacted"))).toBe("helpdesk.upload_failed");
    expect(supportUploadErrorKey(new Error("helpdesk.media_verification_failed"))).toBe("helpdesk.media_verification_failed");
    expect(supportUploadErrorKey(new Error("helpdesk.upload_timeout"))).toBe("helpdesk.upload_timeout");
  });
});
