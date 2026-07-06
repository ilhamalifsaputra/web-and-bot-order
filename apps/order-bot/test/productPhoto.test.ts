import "./setup-env"; // FIRST import — sets env before @app/* load
import { describe, it, expect, vi } from "vitest";
import { InputFile } from "grammy";
import { productPhotoArg, cacheProductPhotoFileId } from "../src/util/productPhoto";

vi.mock("@app/db", () => ({
  prisma: {},
  updateCatalogProduct: vi.fn().mockResolvedValue(undefined),
}));

import { updateCatalogProduct } from "@app/db";

describe("productPhotoArg", () => {
  it("no photo fields → undefined", () => {
    expect(productPhotoArg({ webImageUrl: null, imageFileId: null })).toBeUndefined();
  });

  it("upload path without cached file_id → InputFile, needsCache true", () => {
    const arg = productPhotoArg({ webImageUrl: "/uploads/products/x.jpg", imageFileId: null });
    expect(arg?.needsCache).toBe(true);
    expect(arg?.photo).toBeInstanceOf(InputFile);
  });

  it("upload path with cached file_id → cached fileId wins, no caching needed", () => {
    const arg = productPhotoArg({ webImageUrl: "/uploads/products/x.jpg", imageFileId: "CACHED_ID" });
    expect(arg).toEqual({ photo: "CACHED_ID", needsCache: false });
  });
});

describe("cacheProductPhotoFileId", () => {
  it("persists the resolved file_id onto the product row via updateCatalogProduct", async () => {
    await cacheProductPhotoFileId(42)("NEW_FILE_ID");
    expect(updateCatalogProduct).toHaveBeenCalledWith(expect.anything(), 42, { imageFileId: "NEW_FILE_ID" });
  });
});
