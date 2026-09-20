import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettlementsPage } from "./SettlementsPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const POSTED = {
  id: 1,
  provider: "TOKOPAY",
  batchReference: "STMT-2026-09-01",
  settlementDateDisplay: "2026-09-01",
  currency: "IDR",
  grossAmount: "1000000",
  feeAmount: "23500",
  netAmount: "976500",
  status: "RECORDED",
  lineCount: 2,
  matchedLineCount: 1,
  postingId: 55,
  recordedAtDisplay: "2026-09-02 09:00",
  recordedBy: 3,
};

const UNPOSTED = {
  ...POSTED,
  id: 2,
  batchReference: "STMT-2026-08-01",
  settlementDateDisplay: "2026-08-01",
  postingId: null,
  lineCount: 0,
  matchedLineCount: 0,
};

const LIST = {
  settlements: [POSTED],
  total: 1,
  page: 1,
  pageSize: 20,
  hasNext: false,
  providers: ["TOKOPAY"],
  currencies: ["IDR", "USDT"],
};

function mockFetch(payload: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("SettlementsPage", () => {
  it("shows each batch's three amounts, formatted, with how many lines matched a payment", async () => {
    mockFetch(LIST);
    render(<SettlementsPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("STMT-2026-09-01")).toBeInTheDocument());
    expect(screen.getByText("Rp1.000.000")).toBeInTheDocument();
    expect(screen.getByText("Rp23.500")).toBeInTheDocument();
    expect(screen.getByText("Rp976.500")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 matched to a payment")).toBeInTheDocument();
    expect(screen.getByText("2026-09-01")).toBeInTheDocument();
  });

  it("warns loudly about a batch that was recorded but never booked to the ledger", async () => {
    mockFetch({ ...LIST, settlements: [UNPOSTED], total: 1 });
    render(<SettlementsPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("Not booked to the ledger")).toBeInTheDocument());
    // The banner explains the consequence, not just the state — an unbooked
    // batch means the cash position is wrong, which a status pill cannot say.
    expect(
      screen.getByText(/cash position is understated/i),
    ).toBeInTheDocument();
  });

  it("says nothing about unbooked batches when every batch on the page is booked", async () => {
    mockFetch(LIST);
    render(<SettlementsPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("STMT-2026-09-01")).toBeInTheDocument());
    expect(screen.queryByText(/cash position is understated/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Not booked to the ledger")).not.toBeInTheDocument();
  });

  it("offers an empty state rather than a bare table when nothing has been recorded", async () => {
    mockFetch({ ...LIST, settlements: [], total: 0, providers: [] });
    render(<SettlementsPage />, { wrapper: Wrapper });

    await waitFor(() =>
      expect(screen.getByText("No settlements recorded yet")).toBeInTheDocument(),
    );
  });

  it("posts the three amounts as the admin typed them, never as numbers", async () => {
    const fetchMock = mockFetch(LIST);
    render(<SettlementsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("STMT-2026-09-01")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /record settlement/i }));
    await userEvent.type(screen.getByLabelText("Settlement date"), "2026-09-01");
    await userEvent.type(screen.getByLabelText("Collected"), "1000000.5000");
    await userEvent.type(screen.getByLabelText("Provider's cut"), "23500.2500");
    await userEvent.type(screen.getByLabelText("Received"), "977000.2500");

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, settlementId: 9, posted: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Record settlement" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/settlements" && (init as RequestInit)?.method === "POST",
      );
      expect(call).toBeDefined();
      const sent = JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
      // Strings, with every decimal place intact — a float round-trip here is
      // exactly how an amount silently loses its tail.
      expect(sent.grossAmount).toBe("1000000.5000");
      expect(sent.feeAmount).toBe("23500.2500");
      expect(sent.netAmount).toBe("977000.2500");
      expect(sent.settlementDate).toBe("2026-09-01");
      expect(sent.provider).toBe("TOKOPAY");
      expect(sent.currency).toBe("IDR");
    });
  });

  it("sends a fee of zero when the admin leaves it blank — a real answer for a hand-entered batch", async () => {
    const fetchMock = mockFetch(LIST);
    render(<SettlementsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("STMT-2026-09-01")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /record settlement/i }));
    await userEvent.type(screen.getByLabelText("Settlement date"), "2026-09-01");
    await userEvent.type(screen.getByLabelText("Collected"), "500000");
    await userEvent.type(screen.getByLabelText("Received"), "500000");

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, settlementId: 9, posted: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Record settlement" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/settlements" && (init as RequestInit)?.method === "POST",
      );
      const sent = JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
      expect(sent.feeAmount).toBe("0");
    });
  });

  it("keeps Record disabled until the date and both required amounts are filled in", async () => {
    mockFetch(LIST);
    render(<SettlementsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("STMT-2026-09-01")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /record settlement/i }));
    const submit = screen.getByRole("button", { name: "Record settlement" });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Settlement date"), "2026-09-01");
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Collected"), "100");
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Received"), "100");
    expect(submit).toBeEnabled();
  });

  it("does NOT auto-fill the third amount from the other two", async () => {
    // Deliberate: `netAmount` is stored rather than derived so a provider's own
    // statement can be recorded verbatim, and a form that computed it would hide
    // the provider's arithmetic error the service exists to refuse.
    mockFetch(LIST);
    render(<SettlementsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("STMT-2026-09-01")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /record settlement/i }));
    await userEvent.type(screen.getByLabelText("Collected"), "1000");
    await userEvent.type(screen.getByLabelText("Provider's cut"), "50");

    expect(screen.getByLabelText("Received")).toHaveValue("");
  });

  it("sends the statement lines an admin added, dropping the ones left blank", async () => {
    const fetchMock = mockFetch(LIST);
    render(<SettlementsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("STMT-2026-09-01")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /record settlement/i }));
    await userEvent.type(screen.getByLabelText("Settlement date"), "2026-09-01");
    await userEvent.type(screen.getByLabelText("Collected"), "1000");
    await userEvent.type(screen.getByLabelText("Received"), "1000");
    await userEvent.click(screen.getByRole("button", { name: /add line/i }));
    await userEvent.click(screen.getByRole("button", { name: /add line/i }));
    const amounts = screen.getAllByLabelText("Statement line amount");
    await userEvent.type(amounts[0]!, "600");
    await userEvent.type(screen.getAllByLabelText("Statement line provider transaction id")[0]!, "TP-1");
    // Second line left empty on purpose — an admin who clicked "Add line" once
    // too often must not have an empty line refused by the server.

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, settlementId: 9, posted: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Record settlement" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/settlements" && (init as RequestInit)?.method === "POST",
      );
      const sent = JSON.parse((call![1] as RequestInit).body as string) as {
        lines: { amount: string; providerTransactionId: string | null }[];
      };
      expect(sent.lines).toEqual([{ amount: "600", providerTransactionId: "TP-1" }]);
    });
  });
});
