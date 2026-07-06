/**
 * Per-broadcast photo resolution — the admin-uploaded `Broadcast.webImageUrl`
 * (or cached `Broadcast.imageFileId`) rendered as the broadcast's photo.
 * Delegates to `bannerPhotoArg` (util/banner.ts), which is already generic
 * over any (url, cachedFileId) pair.
 */
import type { InputFile } from "grammy";
import { prisma, setBroadcastImageFileId } from "@app/db";
import { bannerPhotoArg } from "./banner";

export function broadcastPhotoArg(
  bc: { webImageUrl: string | null; imageFileId: string | null },
): { photo: string | InputFile; needsCache: boolean } | undefined {
  return bannerPhotoArg(bc.webImageUrl, bc.imageFileId);
}

/** Cache the resolved file_id onto the broadcast row after its first photo send. */
export function cacheBroadcastPhotoFileId(broadcastId: number) {
  return async (fileId: string): Promise<void> => {
    await setBroadcastImageFileId(prisma, broadcastId, fileId);
  };
}
