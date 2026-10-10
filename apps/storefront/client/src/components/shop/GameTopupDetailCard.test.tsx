import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import GameTopupDetailCard from "./GameTopupDetailCard";

const LONG_SN = "SN-" + "A1b2C3d4".repeat(25) + "-END";

describe("GameTopupDetailCard", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("shows product, denomination, Game/Zone IDs and the full 200+ char SN", () => {
    expect(LONG_SN.length).toBeGreaterThan(200);
    render(
      <GameTopupDetailCard
        items={[{ name: "Mobile Legends", duration: "86 Diamonds" }]}
        targets={[{ game_id: "12345678", zone_id: "2222" }]}
        sn={LONG_SN}
      />,
    );
    expect(screen.getByRole("heading", { name: "Top-up details" })).toBeInTheDocument();
    expect(screen.getByText("Mobile Legends")).toBeInTheDocument();
    expect(screen.getByText("86 Diamonds")).toBeInTheDocument();
    expect(screen.getByText("Game ID")).toBeInTheDocument();
    expect(screen.getByText("12345678")).toBeInTheDocument();
    expect(screen.getByText("Zone ID")).toBeInTheDocument();
    expect(screen.getByText("2222")).toBeInTheDocument();
    expect(screen.getByText(LONG_SN)).toBeInTheDocument();
  });

  it("copies the SN in full", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<GameTopupDetailCard items={[]} targets={[]} sn={LONG_SN} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));
    expect(writeText).toHaveBeenCalledWith(LONG_SN);
  });

  it("omits every line that has no value (no empty labels)", () => {
    render(<GameTopupDetailCard items={[{ name: "Free Fire", duration: null }]} targets={[{ game_id: "999" }]} sn={null} />);
    expect(screen.getByText("Game ID")).toBeInTheDocument();
    expect(screen.queryByText("Zone ID")).not.toBeInTheDocument();
    expect(screen.queryByText("Server ID")).not.toBeInTheDocument();
    expect(screen.queryByText("SN / reference")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Copy/ })).not.toBeInTheDocument();
  });

  it("renders nothing when there is nothing to show", () => {
    const { container } = render(<GameTopupDetailCard items={[]} targets={[]} sn={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels each unit when several units have targets", () => {
    render(
      <GameTopupDetailCard
        items={[]}
        targets={[{ game_id: "111", server_id: "S1" }, { game_id: "222", server_id: "S2" }]}
        sn={null}
      />,
    );
    expect(screen.getByText("Unit 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Unit 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("111")).toBeInTheDocument();
    expect(screen.getByText("S2")).toBeInTheDocument();
    expect(screen.getAllByText("Server ID")).toHaveLength(2);
  });

  it("shows the Digiflazz status line while pending or under review", () => {
    const { rerender } = render(<GameTopupDetailCard items={[]} targets={[{ game_id: "1" }]} sn={null} digiflazzStatus="pending" />);
    expect(screen.getByText(/finalizing your top-up/)).toBeInTheDocument();
    rerender(<GameTopupDetailCard items={[]} targets={[{ game_id: "1" }]} sn={null} digiflazzStatus="reviewing" />);
    expect(screen.getByText(/team is reviewing/)).toBeInTheDocument();
  });
});
