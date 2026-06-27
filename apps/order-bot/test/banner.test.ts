import "./setup-env"; // FIRST import — sets env before @app/* load
import { describe, it, expect } from "vitest";
import { InputFile } from "grammy";
import { resolveBannerValue, bannerPhotoArg } from "../src/util/banner";

describe("resolveBannerValue", () => {
  it("empty / null → none", () => {
    expect(resolveBannerValue(null, null)).toEqual({ kind: "none" });
    expect(resolveBannerValue("   ", null)).toEqual({ kind: "none" });
  });

  it("legacy Telegram file_id → fileId passthrough", () => {
    expect(resolveBannerValue("AgACAgQ_legacy", null)).toEqual({ kind: "fileId", fileId: "AgACAgQ_legacy" });
  });

  it("upload path without cache → upload", () => {
    expect(resolveBannerValue("/uploads/branding/banner-abc.png", null)).toEqual({
      kind: "upload",
      relPath: "branding/banner-abc.png",
    });
  });

  it("upload path with cached file_id → fileId (cache wins)", () => {
    expect(resolveBannerValue("/uploads/branding/banner-abc.png", "CACHED_ID")).toEqual({
      kind: "fileId",
      fileId: "CACHED_ID",
    });
  });
});

describe("bannerPhotoArg", () => {
  it("none → undefined", () => {
    expect(bannerPhotoArg(null, null)).toBeUndefined();
  });

  it("fileId → string photo, no caching", () => {
    expect(bannerPhotoArg("FILEID", null)).toEqual({ photo: "FILEID", needsCache: false });
  });

  it("upload without cache → InputFile, needsCache true", () => {
    const arg = bannerPhotoArg("/uploads/branding/banner-x.png", null);
    expect(arg?.needsCache).toBe(true);
    expect(arg?.photo).toBeInstanceOf(InputFile);
  });
});
