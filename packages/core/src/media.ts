/**
 * Shared file-signature sniffing for user-uploaded media — used by every
 * multipart upload handler (web-admin's branding/catalog photos, the
 * storefront's ticket-evidence uploads) so this security-sensitive check
 * lives in exactly one place.
 */

/**
 * Sniff the real image type from a file's magic bytes (M-6). Returns a canonical
 * MIME, or null when the bytes don't look like a supported image. SVG is text
 * (no binary signature) so it's matched by a leading `<svg`/XML heuristic.
 */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return "image/x-icon";
  const head = buf.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  if (head.includes("<svg")) return "image/svg+xml";
  return null;
}

/** Collapse the two icon MIME spellings so a sniffed type matches either header. */
export const canonicalImageMime = (m: string): string =>
  m === "image/vnd.microsoft.icon" ? "image/x-icon" : m;
