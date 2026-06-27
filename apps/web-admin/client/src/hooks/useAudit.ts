import { useQuery } from "@tanstack/react-query";

export interface AuditRow {
  id: number;
  adminId: number;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: string | null;
  createdAt: string;
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
  since?: string;
  until?: string;
}) {
  const search = new URLSearchParams();
  if (params.page && params.page > 1) search.set("page", String(params.page));
  if (params.action) search.set("action", params.action);
  if (params.targetType) search.set("target_type", params.targetType);
  if (params.adminId) search.set("admin_id", params.adminId);
  if (params.since) search.set("since", params.since);
  if (params.until) search.set("until", params.until);

  return useQuery<AuditResponse>({
    queryKey: ["audit", params],
    queryFn: async () => {
      const res = await fetch(`/api/audit?${search}`, { credentials: "include" });
      if (!res.ok) throw new Error(`/api/audit ${res.status}`);
      return res.json() as Promise<AuditResponse>;
    },
  });
}
