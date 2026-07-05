import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReferralPage from "./ReferralPage";
import { apiGet } from "../api/client";
import type { ReferralData } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
}));

function renderReferral(data: ReferralData) {
  (apiGet as Mock).mockResolvedValue(data);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/account/referral"]}>
        <Routes>
          <Route path="/account/referral" element={<ReferralPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ReferralPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
  });

  it("renders the referral code and link, and copies the link on click", async () => {
    renderReferral({ referral_code: "ALICE01", referral_link: "https://t.me/tokobot?start=ref_ALICE01" });
    expect(await screen.findByText("ALICE01")).toBeInTheDocument();
    const input = screen.getByDisplayValue("https://t.me/tokobot?start=ref_ALICE01") as HTMLInputElement;
    expect(input).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://t.me/tokobot?start=ref_ALICE01");
  });

  it("renders an empty link field when referral_link is null", async () => {
    renderReferral({ referral_code: "ALICE01", referral_link: null });
    await screen.findByText("ALICE01");
    expect(screen.getByDisplayValue("")).toBeInTheDocument();
  });
});
