import { useQuery } from "@tanstack/react-query";

/** One row of the shop-wide wallet ledger (GET /api/wallet-transactions).
 *  The `user` relation is a deliberately narrow projection server-side — it
 *  never carries passwordHash or email. */
export interface WalletTransactionRow {
  id: number;
  userId: number;
  customerLabel: string;
  /** Signed: positive credits the wallet, negative debits it. */
  delta: string;
  balanceAfter: string;
  currency: string;
  reason: string;
  note: string;
  adminId: number | null;
  orderId: number | null;
  createdAt: string;
  createdAtDisplay: string | null;
  user: { id: number; username: string | null; fullName: string | null; telegramId: string | null } | null;
}

export interface WalletTransactionsResponse {
  rows: WalletTransactionRow[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  /** Machine reason codes the server accepts, so the dropdown cannot drift
   *  from the server's validation list. */
  reasons: string[];
}

export function useWalletTransactions(params: {
  page?: number;
  reason?: string;
  currency?: string;
  userId?: string;
  since?: string;
  until?: string;
}) {
  const search = new URLSearchParams();
  if (params.page && params.page > 1) search.set("page", String(params.page));
  if (params.reason) search.set("reason", params.reason);
  if (params.currency) search.set("currency", params.currency);
  if (params.userId) search.set("user_id", params.userId);
  if (params.since) search.set("since", params.since);
  if (params.until) search.set("until", params.until);

  return useQuery<WalletTransactionsResponse>({
    queryKey: ["wallet-transactions", params],
    queryFn: async () => {
      const res = await fetch(`/api/wallet-transactions?${search}`, { credentials: "include" });
      if (!res.ok) throw new Error(`/api/wallet-transactions ${res.status}`);
      return res.json() as Promise<WalletTransactionsResponse>;
    },
  });
}
