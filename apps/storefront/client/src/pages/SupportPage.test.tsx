import "@testing-library/jest-dom";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import SupportPage from "./SupportPage";
function Location() { const location = useLocation(); return <p>{location.pathname + location.search}</p>; }
describe("legacy support entry", () => {
  it.each(["", "?order=ORD-OWNED"]) ("opens the unified help center retaining context %s", async (query) => {
    render(<MemoryRouter initialEntries={[`/account/support${query}`]}><Routes><Route path="/account/support" element={<SupportPage />} /><Route path="/help" element={<Location />} /></Routes></MemoryRouter>);
    expect(await screen.findByText(`/help${query}`)).toBeInTheDocument();
  });
});
