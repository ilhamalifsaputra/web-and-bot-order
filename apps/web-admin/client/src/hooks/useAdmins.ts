import { useQuery } from "@tanstack/react-query";

export interface AdminRow {
  /** Internal `User.id` — null when this admin has never messaged the bot
   *  (no `User` row yet). This is the id `logAdminAction` records as
   *  `adminId` on the audit log, distinct from `telegramId` below. */
  id: number | null;
  telegramId: number;
  role: string;
  passwordSet: boolean;
  twoFa: boolean;
  hasSession: boolean;
  name: string | null;
  isSelf: boolean;
  fromEnv: boolean;
}

export interface AdminsResponse {
  admins: AdminRow[];
  roles: string[];
}

/**
 * Fetches the registered-admins list (`GET /api/admins`). Shared by
 * `AdminsPage.tsx` (the admins management table) and `AuditPage.tsx` (to
 * resolve an audit row's numeric `adminId` to a display name — see F-004).
 *
 * The backend route is super-admin only (`requireSuper` in
 * `apps/web-admin/src/routes/api/admins.ts`), so callers other than
 * AdminsPage must tolerate a 403 for non-super roles: react-query surfaces
 * that as a normal `isError` state rather than throwing during render, so
 * callers should treat a missing/errored result as "name unavailable" and
 * fall back gracefully instead of failing.
 */
export function useAdmins() {
  return useQuery<AdminsResponse>({
    queryKey: ["admins"],
    queryFn: async () => {
      const res = await fetch("/api/admins");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<AdminsResponse>;
    },
  });
}
