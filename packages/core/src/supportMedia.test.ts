import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectSupportMedia, resolveSupportBucket, supportMediaAvailable, supportObjectUrl } from "./supportMedia";

let sequence = 0;
const bucketXml = (...names: string[]) => `<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><DisplayName>owner</DisplayName></Owner><Buckets>${names.map((name) => `<Bucket><Name>${name}</Name><CreationDate>2026-01-01</CreationDate></Bucket>`).join("")}</Buckets></ListAllMyBucketsResult>`;
beforeEach(() => {
  vi.stubEnv("SUPPORT_R2_ACCOUNT_ID", "a".repeat(32));
  vi.stubEnv("SUPPORT_R2_ACCESS_KEY_ID", `test-key-${++sequence}`);
  vi.stubEnv("SUPPORT_R2_SECRET_ACCESS_KEY", "test-secret");
  vi.stubEnv("SUPPORT_R2_BUCKET", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("private support storage selection", () => {
  it("discovers the only bucket without a configured name, coalesces requests and signs objects there", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(bucketXml("arbitrary-storage-name")));
    vi.stubGlobal("fetch", fetcher);
    expect(await Promise.all([resolveSupportBucket(), resolveSupportBucket(), resolveSupportBucket()])).toEqual(Array(3).fill("arbitrary-storage-name"));
    const url = new URL(await supportObjectUrl("support/file.png", "PUT", "image/png"));
    expect(url.pathname).toBe("/arbitrary-storage-name/support/file.png");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("180");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBeInstanceOf(Request);
    expect((fetcher.mock.calls[0]![0] as Request).headers.has("Authorization")).toBe(true);
  });
  it.each([[], ["one-bucket", "two-buckets"]])("refuses ambiguous discovery: %j", async (...names) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bucketXml(...names))));
    await expect(resolveSupportBucket()).rejects.toMatchObject({ key: "helpdesk.r2_bucket_ambiguous" });
    expect(await supportMediaAvailable()).toBe(false);
  });
  it("uses an explicit name with object-scoped credentials and no list request", async () => {
    vi.stubEnv("SUPPORT_R2_BUCKET", "my-configured-bucket");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await resolveSupportBucket()).toBe("my-configured-bucket");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps an existing attachment pinned to its persisted bucket despite new configuration", async () => {
    vi.stubEnv("SUPPORT_R2_BUCKET", "new-upload-destination");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const url = new URL(await supportObjectUrl("support-ready/file.jpg", "GET", undefined, undefined, "original-destination"));
    expect(url.pathname).toBe("/original-destination/support-ready/file.jpg");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses malformed or truncated list responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('<ListAllMyBucketsResult><Buckets><Bucket><Name>only-bucket</Name></Bucket></Buckets><IsTruncated>true</IsTruncated></ListAllMyBucketsResult>')));
    await expect(resolveSupportBucket()).rejects.toMatchObject({ key: "helpdesk.r2_discovery_failed" });
  });
  it("bounds discovery payloads instead of buffering arbitrary upstream data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(65_537))));
    await expect(resolveSupportBucket()).rejects.toMatchObject({ key: "helpdesk.r2_bucket_ambiguous" });
  });
  it("does not propagate network errors containing credentials or signed URLs", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("sensitive upstream URL")); vi.stubGlobal("fetch", fetcher);
    await expect(resolveSupportBucket()).rejects.toMatchObject({ key: "helpdesk.r2_discovery_failed" });
    await expect(resolveSupportBucket()).rejects.not.toHaveProperty("message", "sensitive upstream URL");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("invalidates discovery cache when credentials change", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(bucketXml("first-bucket"))).mockResolvedValueOnce(new Response(bucketXml("second-bucket")));
    vi.stubGlobal("fetch", fetcher);
    expect(await resolveSupportBucket()).toBe("first-bucket");
    vi.stubEnv("SUPPORT_R2_SECRET_ACCESS_KEY", "rotated-secret");
    expect(await resolveSupportBucket()).toBe("second-bucket");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects unauthorized list calls and keeps uploads unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Denied", { status: 403 })));
    expect(await supportMediaAvailable()).toBe(false);
    await expect(resolveSupportBucket()).rejects.toMatchObject({ key: "helpdesk.r2_discovery_failed" });
  });
  it("rejects HTML or a renamed video rather than trusting file extensions", () => {
    expect(inspectSupportMedia(Buffer.from("<html>not an image</html>"), "image/jpeg")).toBe(false);
    expect(inspectSupportMedia(Buffer.from("<html>not a video</html>"), "video/mp4")).toBe(false);
    const mp4 = Buffer.alloc(24); mp4.writeUInt32BE(24); mp4.write("ftyp", 4); mp4.write("isom", 8);
    expect(inspectSupportMedia(mp4, "video/mp4")).toBe(true);
  });
});
