import { describe, it, expect } from "vitest";
import {
  MAX_TICKET_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  IMAGE_TYPES,
  VIDEO_TYPES,
  validateNewFiles,
} from "./attachmentValidation";

function makeFile(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(Math.max(0, Math.min(size, 1)))], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("attachmentValidation constants", () => {
  it("re-exports the expected limits", () => {
    expect(MAX_TICKET_ATTACHMENTS).toBe(3);
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_VIDEO_BYTES).toBe(20 * 1024 * 1024);
    expect(IMAGE_TYPES.has("image/png")).toBe(true);
    expect(VIDEO_TYPES.has("video/mp4")).toBe(true);
  });
});

describe("validateNewFiles", () => {
  it("accepts up to 3 valid image files; the 4th yields a count error", () => {
    const valid = [
      makeFile("a.png", "image/png", 1024),
      makeFile("b.png", "image/png", 1024),
      makeFile("c.png", "image/png", 1024),
    ];
    const fourth = makeFile("d.png", "image/png", 1024);
    const result = validateNewFiles([], [...valid, fourth]);
    expect(result.accepted).toEqual(valid);
    expect(result.errorKey).toBe("web.support_attach_error_count");
  });

  it("rejects an unsupported type", () => {
    const file = makeFile("notes.txt", "text/plain", 100);
    const result = validateNewFiles([], [file]);
    expect(result.accepted).toEqual([]);
    expect(result.errorKey).toBe("web.support_attach_error_type");
  });

  it("rejects an oversize image (6MB)", () => {
    const file = makeFile("big.png", "image/png", 6 * 1024 * 1024);
    const result = validateNewFiles([], [file]);
    expect(result.accepted).toEqual([]);
    expect(result.errorKey).toBe("web.support_attach_error_size");
  });

  it("rejects a 21MB video but accepts a 19MB video", () => {
    const tooBig = makeFile("big.mp4", "video/mp4", 21 * 1024 * 1024);
    const okVideo = makeFile("ok.mp4", "video/mp4", 19 * 1024 * 1024);

    const rejected = validateNewFiles([], [tooBig]);
    expect(rejected.accepted).toEqual([]);
    expect(rejected.errorKey).toBe("web.support_attach_error_size");

    const accepted = validateNewFiles([], [okVideo]);
    expect(accepted.accepted).toEqual([okVideo]);
    expect(accepted.errorKey).toBeNull();
  });

  it("in a mixed batch, accepts the valid file and continues past the oversize one", () => {
    const valid = makeFile("ok.png", "image/png", 1024);
    const oversize = makeFile("big.png", "image/png", 6 * 1024 * 1024);
    const result = validateNewFiles([], [valid, oversize]);
    expect(result.accepted).toEqual([valid]);
    expect(result.errorKey).toBe("web.support_attach_error_size");
  });
});
