import "./setup-env"; // FIRST import — sets env before @app/* load
import { describe, it, expect } from "vitest";
import { InputFile } from "grammy";
import { resolveQrValue, qrPhotoArg } from "../src/util/qr";

describe("resolveQrValue", () => {
  it("empty / null → none", () => {
    expect(resolveQrValue(null, null)).toEqual({ kind: "none" });
    expect(resolveQrValue("   ", null)).toEqual({ kind: "none" });
  });

  it("legacy Telegram file_id → fileId passthrough", () => {
    expect(resolveQrValue("AgACAgQ_legacy", null)).toEqual({ kind: "fileId", fileId: "AgACAgQ_legacy" });
  });

  it("upload path without cache → upload", () => {
    expect(resolveQrValue("/uploads/qr/qr-abc.png", null)).toEqual({
      kind: "upload",
      relPath: "qr/qr-abc.png",
    });
  });

  it("upload path with cached file_id → fileId (cache wins)", () => {
    expect(resolveQrValue("/uploads/qr/qr-abc.png", "CACHED_ID")).toEqual({
      kind: "fileId",
      fileId: "CACHED_ID",
    });
  });
});

describe("qrPhotoArg", () => {
  it("none → undefined", () => {
    expect(qrPhotoArg(null, null)).toBeUndefined();
  });

  it("fileId → string photo, no caching", () => {
    expect(qrPhotoArg("FILEID", null)).toEqual({ photo: "FILEID", needsCache: false });
  });

  it("upload without cache → InputFile, needsCache true", () => {
    const arg = qrPhotoArg("/uploads/qr/qr-x.png", null);
    expect(arg?.needsCache).toBe(true);
    expect(arg?.photo).toBeInstanceOf(InputFile);
  });

  it("upload with cached file_id → string photo, no further caching", () => {
    const arg = qrPhotoArg("/uploads/qr/qr-x.png", "CACHED_ID");
    expect(arg).toEqual({ photo: "CACHED_ID", needsCache: false });
  });
});
