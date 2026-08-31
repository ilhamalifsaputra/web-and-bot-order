import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useAdmins } from "./useAdmins";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useAdmins", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          admins: [
            { id: 1, telegramId: 123, role: "super", passwordSet: true, twoFa: false, hasSession: true, name: "Admin", isSelf: true, fromEnv: false },
          ],
          roles: ["super", "admin"],
        }),
      })),
    );
  });

  it("fetches /api/admins with credentials and returns the parsed response", async () => {
    const { result } = renderHook(() => useAdmins(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.admins).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith("/api/admins", expect.objectContaining({ credentials: "include" }));
  });
});
