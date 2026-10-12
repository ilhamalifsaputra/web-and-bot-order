import { useEffect, useRef, useState } from "react";
import { apiPost } from "../api/client";
const UPLOAD_LABELS: Record<string, string> = {
  "helpdesk.upload_failed": "Upload failed. Retry or remove the file.",
  "helpdesk.media_verification_failed": "The file could not be verified. Remove it and choose a valid photo or MP4.",
  "helpdesk.media_unavailable": "Support uploads are unavailable.",
  "helpdesk.upload_network": "Network unavailable. Check your connection and retry.",
  "helpdesk.upload_timeout": "Upload timed out. Check your connection and retry.",
  "helpdesk.upload_denied": "Upload access expired or was denied. Retry, or reload to sign in again.",
  "helpdesk.upload_server": "Storage is temporarily unavailable. Please retry shortly.",
  "helpdesk.upload_ticket_unavailable": "This ticket or upload is unavailable. Refresh the ticket before attaching files.",
  "helpdesk.upload_type": "Use a JPG, PNG, WebP photo or MP4 video.",
  "helpdesk.upload_size": "The file is empty or exceeds the {limit} MB limit.",
  "helpdesk.upload_quota": "The upload limit has been reached. Remove unused files or try again later."
};
const t = (key: string, args?: { limit: number }) => (UPLOAD_LABELS[key] ?? key).replace("{limit}", String(args?.limit ?? ""));


const UPLOAD_ERROR_KEYS = new Set(["helpdesk.upload_network", "helpdesk.upload_timeout", "helpdesk.upload_denied", "helpdesk.media_verification_failed", "helpdesk.media_unavailable", "helpdesk.upload_failed"]);
export function supportUploadErrorKey(error: unknown): string {
  if (!(error instanceof Error)) return "helpdesk.upload_failed";
  if (UPLOAD_ERROR_KEYS.has(error.message)) return error.message;
  if (error.message === "web.support_attach_error_count") return "helpdesk.upload_quota";
  const status = (error as { status?: number }).status;
  if (status === 401 || status === 403) return "helpdesk.upload_denied";
  if (status === 404 || status === 409) return "helpdesk.upload_ticket_unavailable";
  if (status === 429) return "helpdesk.upload_quota";
  if (status && status >= 500) return "helpdesk.upload_server";
  return "helpdesk.upload_failed";
}

export interface SupportUpload { key: string; file: File; attempts?: number; id?: string; progress: number; state: "uploading" | "verifying" | "ready" | "failed"; error?: string }
const BASE = "/api/support/uploads";

/** Files go directly to private R2; only metadata goes through Fastify. */
export interface SupportMediaLimits { imageBytes?: number; videoBytes?: number }
export function useSupportUploads(ticketId?: number, limits?: SupportMediaLimits) {
  const [files, setFiles] = useState<SupportUpload[]>([]);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const queue = useRef<Promise<void> | null>(null);
  const controllers = useRef(new Map<string, XMLHttpRequest>());
  const active = useRef(new Set<string>());
  useEffect(() => {
    const requests = controllers.current;
    const keys = active.current;
    return () => { keys.clear(); requests.forEach((xhr) => xhr.abort()); };
  }, []);
  const update = (key: string, patch: Partial<SupportUpload>) => setFiles((items) => items.map((f) => f.key === key ? { ...f, ...patch } : f));
  async function upload(item: SupportUpload) {
    if (!active.current.has(item.key)) return;
    update(item.key, { state: "uploading", progress: 0, error: undefined });
    try {
      if (item.id) await apiPost(`${BASE}/${item.id}/abort`, {});
      update(item.key, { attempts: (item.attempts ?? 0) + 1 });
      const intent = await apiPost<{ id: string; url: string; headers: Record<string, string> }>(BASE, { draft_id: draftId, ticket_id: ticketId, filename: item.file.name, mime: item.file.type, bytes: item.file.size });
      if (!active.current.has(item.key)) { await apiPost(`${BASE}/${intent.id}/abort`, {}); return; }
      update(item.key, { id: intent.id });
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest(); controllers.current.set(item.key, xhr);
        xhr.open("PUT", intent.url); xhr.timeout = 120_000;
        Object.entries(intent.headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
        xhr.upload.onprogress = (event) => { if (event.lengthComputable) update(item.key, { progress: Math.round(event.loaded / event.total * 100) }); };
        xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(Object.assign(new Error("Storage upload refused."), { status: xhr.status }));
        xhr.onerror = () => reject(new Error("helpdesk.upload_network"));
        xhr.ontimeout = () => reject(new Error("helpdesk.upload_timeout"));
        xhr.onabort = () => reject(new Error("helpdesk.upload_failed"));
        xhr.send(item.file);
      });
      update(item.key, { state: "verifying", progress: 100 });
      await apiPost(`${BASE}/${intent.id}/finalize`, {});
      update(item.key, { state: "ready" });
    } catch (error) { update(item.key, { state: "failed", error: t(supportUploadErrorKey(error)) }); }
    finally { controllers.current.delete(item.key); }
  }
  function add(incoming: File[]) {
    const items = incoming.slice(0, 3 - active.current.size).map((file): SupportUpload => {
      const allowed = ["image/jpeg", "image/png", "image/webp", "video/mp4"].includes(file.type);
      const maximum = file.type.startsWith("image/") ? (limits?.imageBytes ?? 5 * 1024 ** 2) : (limits?.videoBytes ?? 20 * 1024 ** 2);
      const valid = allowed && file.size > 0 && file.size <= maximum;
      const key = crypto.randomUUID();
      return { key, file, progress: 0, state: valid ? "uploading" : "failed", attempts: valid ? undefined : 3, error: valid ? undefined : !allowed ? t("helpdesk.upload_type") : t("helpdesk.upload_size", { limit: maximum / 1024 ** 2 }) };
    });
    items.forEach((item) => active.current.add(item.key));
    setFiles((previous) => [...previous, ...items]);
    // Small bounded batches: no video buffers or simultaneous unbounded uploads.
    items.filter((item) => item.state !== "failed").forEach((item) => { queue.current = (queue.current ?? Promise.resolve()).then(() => upload(item)); });
  }
  function remove(item: SupportUpload) {
    active.current.delete(item.key); controllers.current.get(item.key)?.abort();
    setFiles((previous) => previous.filter((file) => file.key !== item.key));
    if (item.id) void apiPost(`${BASE}/${item.id}/abort`, {}).catch(() => undefined);
  }
  function reset() { setFiles([]); setDraftId(crypto.randomUUID()); active.current.clear(); }
  return { files, limits: { imageBytes: limits?.imageBytes ?? 5 * 1024 ** 2, videoBytes: limits?.videoBytes ?? 20 * 1024 ** 2 }, add, remove, retry: (item: SupportUpload) => { if ((item.attempts ?? 0) >= 3) return; active.current.add(item.key); queue.current = (queue.current ?? Promise.resolve()).then(() => upload(item)); }, reset, ids: files.flatMap((f) => f.id && f.state === "ready" ? [f.id] : []), busy: files.some((f) => f.state !== "ready") };
}
