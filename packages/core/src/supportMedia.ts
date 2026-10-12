import { AwsClient } from "aws4fetch";
import { ValidationError } from "./errors";
import { sniffImageMime } from "./media";

export const SUPPORT_MEDIA_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4" } as const;
export function supportMediaLimits() {
  const limit = (key: string, fallback: number, max: number) => Math.min(max, Math.max(1, Number(process.env[key]) || fallback));
  return { files: 3, imageBytes: limit("SUPPORT_IMAGE_MB", 5, 5) * 1024 ** 2, videoBytes: limit("SUPPORT_VIDEO_MB", 20, 20) * 1024 ** 2 };
}
export function supportMediaConfigured() {
  return ["SUPPORT_R2_ACCOUNT_ID", "SUPPORT_R2_ACCESS_KEY_ID", "SUPPORT_R2_SECRET_ACCESS_KEY"].every((key) => !!process.env[key]?.trim());
}
export function supportMediaType(type: string, size: number) {
  const ext = SUPPORT_MEDIA_TYPES[type as keyof typeof SUPPORT_MEDIA_TYPES];
  if (!ext) throw new ValidationError("web.support_attach_error_type");
  const limits = supportMediaLimits();
  if (!Number.isSafeInteger(size) || size <= 0 || size > (type.startsWith("image/") ? limits.imageBytes : limits.videoBytes)) throw new ValidationError("web.support_attach_error_size");
  return ext;
}

interface R2Credentials { account: string; accessKey: string; secret: string }
let bucketCache: { credentials: R2Credentials; expiresAt: number; result: Promise<string> } | undefined;
function r2Credentials(): R2Credentials {
  if (!supportMediaConfigured()) throw new ValidationError("helpdesk.media_unavailable");
  const credentials = { account: process.env.SUPPORT_R2_ACCOUNT_ID!.trim(), accessKey: process.env.SUPPORT_R2_ACCESS_KEY_ID!.trim(), secret: process.env.SUPPORT_R2_SECRET_ACCESS_KEY!.trim() };
  if (!/^[a-f0-9]{32}$/i.test(credentials.account)) throw new ValidationError("helpdesk.media_unavailable");
  return credentials;
}
function r2Client(credentials: R2Credentials) {
  return new AwsClient({ accessKeyId: credentials.accessKey, secretAccessKey: credentials.secret, service: "s3", region: "auto" });
}
function validBucket(name: string) { return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name); }

/** No hardcoded bucket. An explicit override works with object-scoped keys;
 * otherwise use ListBuckets and require exactly one result, never list order.
 * Bound network work and coalesce concurrent discovery calls per process. */
export async function resolveSupportBucket(): Promise<string> {
  const credentials = r2Credentials();
  const explicit = process.env.SUPPORT_R2_BUCKET?.trim();
  if (explicit) {
    if (!validBucket(explicit)) throw new ValidationError("helpdesk.media_unavailable");
    return explicit;
  }
  if (bucketCache && bucketCache.expiresAt > Date.now() && Object.entries(credentials).every(([key, value]) => bucketCache!.credentials[key as keyof R2Credentials] === value)) return bucketCache.result;
  const result = discoverSupportBucket(credentials);
  const cached = { credentials, expiresAt: Date.now() + 60_000, result };
  bucketCache = cached;
  void result.then(() => { cached.expiresAt = Date.now() + 600_000; }, () => undefined);
  return result;
}
async function discoverSupportBucket(credentials: R2Credentials): Promise<string> {
  try {
    const request = await r2Client(credentials).sign(`https://${credentials.account}.r2.cloudflarestorage.com/`);
    const response = await fetch(request, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !response.body) throw new ValidationError("helpdesk.r2_discovery_failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 65_536) throw new ValidationError("helpdesk.r2_bucket_ambiguous");
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    const xml = Buffer.concat(chunks).toString("utf8");
    if (/<!DOCTYPE|<Error\b|<IsTruncated>\s*true|<ContinuationToken>[^<]+/i.test(xml) || !/<(?:[\w-]+:)?ListAllMyBucketsResult\b/.test(xml)) throw new ValidationError("helpdesk.r2_discovery_failed");
    const buckets = Array.from(xml.matchAll(/<(?:[\w-]+:)?Bucket\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Bucket>/g), (match) => /<(?:[\w-]+:)?Name>([^<]+)<\/(?:[\w-]+:)?Name>/.exec(match[1]!)?.[1]?.trim());
    if (buckets.length !== 1) throw new ValidationError("helpdesk.r2_bucket_ambiguous");
    if (!buckets[0] || !validBucket(buckets[0])) throw new ValidationError("helpdesk.r2_discovery_failed");
    return buckets[0];
  } catch (error) {
    // Never surface a signed request, credential, or upstream response body.
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("helpdesk.r2_discovery_failed");
  }
}
export async function supportMediaAvailable() {
  if (!supportMediaConfigured()) return false;
  try { await resolveSupportBucket(); return true; } catch { return false; }
}

/** Short bearer URLs are only minted after the API has authorized the owner. */
export async function supportObjectUrl(key: string, method: "GET" | "PUT" | "HEAD" | "DELETE", type?: string, extraHeaders?: Record<string, string>, bucket?: string) {
  const credentials = r2Credentials();
  const selected = bucket ?? await resolveSupportBucket();
  if (!validBucket(selected)) throw new ValidationError("helpdesk.media_unavailable");
  const client = r2Client(credentials);
  const path = [selected, ...key.split("/")].map(encodeURIComponent).join("/");
  const url = `https://${credentials.account}.r2.cloudflarestorage.com/${path}?X-Amz-Expires=180`;
  return (await client.sign(new Request(url, { method, headers: { ...(type ? { "Content-Type": type } : {}), ...extraHeaders } }), { aws: { signQuery: true, allHeaders: true } })).url;
}

export function inspectSupportMedia(prefix: Buffer, type: string): boolean {
  if (type.startsWith("image/")) return sniffImageMime(prefix) === type;
  // ISO BMFF: a real, bounded ftyp box and a supported MP4 brand; SVG/HTML
  // and QuickTime renamed to .mp4 are refused. This is format inspection,
  // not an antivirus guarantee; objects remain private and nosniff is used.
  if (type !== "video/mp4" || prefix.length < 16 || prefix.toString("ascii", 4, 8) !== "ftyp") return false;
  const size = prefix.readUInt32BE(0);
  return size >= 16 && size <= prefix.length && /^(isom|iso[2-9]|mp4[12]|avc1|M4V )$/.test(prefix.toString("ascii", 8, 12));
}

/** Read only the first 4KiB for inspection. Never buffer an entire video. */
export async function inspectSupportObject(key: string, type: string, size: number, etag?: string, bucket?: string) {
  supportMediaType(type, size);
  const response = await fetch(await supportObjectUrl(key, "GET", undefined, undefined, bucket), { headers: { Range: "bytes=0-4095", ...(etag ? { "If-Match": etag } : {}) }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) throw new ValidationError("helpdesk.media_verification_failed");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let count = 0;
  try {
    while (count < 4096) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value.subarray(0, 4096 - count));
      chunks.push(chunk); count += chunk.length;
    }
  } finally { await reader.cancel(); }
  if (!inspectSupportMedia(Buffer.concat(chunks), type)) throw new ValidationError("helpdesk.media_verification_failed");
}
