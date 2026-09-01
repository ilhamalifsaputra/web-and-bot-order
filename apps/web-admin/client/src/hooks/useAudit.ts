import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";

export interface AuditRow {
  id: number;
  adminId: number | null;
  // "ADMIN" | "CUSTOMER" (Phase H). Defaults to "ADMIN" server-side, but
  // every row this hook can return carries it explicitly.
  actorType: string;
  customerId: number | null;
  telegramUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: string | null;
  createdAt: string;
  createdAtDisplay: string | null;
}

export interface AuditResponse {
  rows: AuditRow[];
  total: number;
  page: number;
  hasNext: boolean;
}

export function useAudit(params: {
  page?: number;
  action?: string;
  targetType?: string;
  adminId?: string;
  actorType?: string;
  since?: string;
  until?: string;
}) {
  const search = new URLSearchParams();
  if (params.page && params.page > 1) search.set("page", String(params.page));
  if (params.action) search.set("action", params.action);
  if (params.targetType) search.set("target_type", params.targetType);
  if (params.adminId) search.set("admin_id", params.adminId);
  if (params.actorType) search.set("actor_type", params.actorType);
  if (params.since) search.set("since", params.since);
  if (params.until) search.set("until", params.until);

  return useQuery<AuditResponse>({
    queryKey: ["audit", params],
    queryFn: () => apiGet<AuditResponse>(`/api/audit?${search}`),
  });
}
