import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuditPage } from "./AuditPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const ROWS = [
  {
    id: 1,
    adminId: 42,
    action: "update_setting",
    targetType: "setting",
    targetId: "shop_name",
    details: "Changed shop name to Demo Shop",
    createdAt: "2026-06-26T10:00:00.000Z",
    createdAtDisplay: "2026-06-26 17:00",
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

/** Both /api/audit and /api/admins are fetched on mount (F-004 resolves the
 *  Admin column's name from the admins list) — route by URL so call order
 *  doesn't matter. */
function mockAuditAndAdmins(
  auditBody: unknown,
  adminsBody: unknown = { admins: [], roles: [] },
  adminsStatus = 200,
) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/admins")) {
      return new Response(JSON.stringify(adminsBody), {
        status: adminsStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(auditBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("AuditPage", () => {
  it("shows audit rows fetched from /api/audit", async () => {
    mockAuditAndAdmins({ rows: ROWS, total: 1, page: 1, hasNext: false });
    render(<AuditPage />, { wrapper: Wrapper });
    // F-005: the Action column now shows a humanized label, not the raw
    // backend code — the raw code is still available via a title tooltip.
    await waitFor(() => expect(screen.getByText("Update Setting")).toBeInTheDocument());
    expect(screen.getByTitle("update_setting")).toBeInTheDocument();
    expect(screen.getByText("Changed shop name to Demo Shop")).toBeInTheDocument();
    expect(screen.getByText("2026-06-26 17:00")).toBeInTheDocument();
  });

  it("maps a known action code to its readable label (F-005)", async () => {
    mockAuditAndAdmins({
      rows: [{ ...ROWS[0], id: 2, action: "denomination_create" }],
      total: 1,
      page: 1,
      hasNext: false,
    });
    render(<AuditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Denomination created")).toBeInTheDocument());
  });

  it("falls back to a humanized version of an unknown action code instead of the raw code (F-005)", async () => {
    mockAuditAndAdmins({
      rows: [{ ...ROWS[0], id: 3, action: "some_future_action" }],
      total: 1,
      page: 1,
      hasNext: false,
    });
    render(<AuditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Some Future Action")).toBeInTheDocument());
  });

  it("shows empty state when no rows", async () => {
    mockAuditAndAdmins({ rows: [], total: 0, page: 1, hasNext: false });
    render(<AuditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no audit entries/i)).toBeInTheDocument());
  });

  it("shows error state on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<AuditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("resolves the Admin column to a name via the admins list, keyed by internal User.id (F-004)", async () => {
    mockAuditAndAdmins(
      { rows: ROWS, total: 1, page: 1, hasNext: false },
      {
        admins: [
          { id: 42, telegramId: 999888, role: "super", passwordSet: true, twoFa: false, hasSession: true, name: "Budi", isSelf: false, fromEnv: true },
        ],
        roles: ["super"],
      },
    );
    render(<AuditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());
    expect(screen.queryByText("42")).not.toBeInTheDocument();
  });

  it("falls back to 'Admin #<id>' when the admins list can't be loaded (e.g. non-super role gets a 403)", async () => {
    mockAuditAndAdmins(
      { rows: ROWS, total: 1, page: 1, hasNext: false },
      { error: "Super-admin only." },
      403,
    );
    render(<AuditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Admin #42")).toBeInTheDocument());
  });
});
