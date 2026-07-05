/**
 * AI-1800 AC2 — Cards show delegate, time-in-state with SLA coloring,
 * and last event as prose.
 *
 * SLA thresholds: neutral <50% of SLA, amber at ≥80% of SLA,
 * red past SLA breach.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BoardCard } from "../components/BoardCard";
import type { BoardTicket } from "../board-types";

function makeTicket(overrides: Partial<BoardTicket> = {}): BoardTicket {
  return {
    ticket_id: "AI-2001",
    workflow: "dev-impl",
    state: "implementation",
    delegate: "igor",
    time_in_state_ms: 0,
    sla_ms: 259200000, // 72h
    last_event_prose: "Igor started implementation, just now",
    terminal: 0,
    muted: false,
    ...overrides,
  };
}

describe("AI-1800 AC2: BoardCard — SLA coloring and card data", () => {
  it("renders the delegate name on the card", () => {
    render(<BoardCard ticket={makeTicket({ delegate: "sage" })} />);
    expect(screen.getByText("sage")).toBeInTheDocument();
  });

  it("renders the ticket identifier", () => {
    render(<BoardCard ticket={makeTicket({ ticket_id: "AI-2002" })} />);
    expect(screen.getByText("AI-2002")).toBeInTheDocument();
  });

  it("renders the last event as prose", () => {
    render(
      <BoardCard ticket={makeTicket({ last_event_prose: "Sage accepted dispatch, 4m ago" })} />,
    );
    expect(screen.getByText("Sage accepted dispatch, 4m ago")).toBeInTheDocument();
  });

  it("applies neutral SLA coloring when time-in-state is below 50% of SLA", () => {
    const { container } = render(
      <BoardCard ticket={makeTicket({ time_in_state_ms: 86400000, sla_ms: 259200000 })} />,
    );
    const slaIndicator = container.querySelector("[data-testid='sla-indicator']");
    expect(slaIndicator).toBeDefined();
    expect(slaIndicator?.getAttribute("data-sla-tone")).toBe("neutral");
  });

  it("applies amber SLA coloring when time-in-state reaches 80% of SLA", () => {
    const { container } = render(
      <BoardCard ticket={makeTicket({ time_in_state_ms: 207360000, sla_ms: 259200000 })} />,
    );
    const slaIndicator = container.querySelector("[data-testid='sla-indicator']");
    expect(slaIndicator).toBeDefined();
    expect(slaIndicator?.getAttribute("data-sla-tone")).toBe("amber");
  });

  it("applies red SLA coloring when time-in-state exceeds SLA breach", () => {
    const { container } = render(
      <BoardCard ticket={makeTicket({ time_in_state_ms: 300000000, sla_ms: 259200000 })} />,
    );
    const slaIndicator = container.querySelector("[data-testid='sla-indicator']");
    expect(slaIndicator).toBeDefined();
    expect(slaIndicator?.getAttribute("data-sla-tone")).toBe("red");
  });

  it("does not show SLA indicator for states without SLA declaration", () => {
    const { container } = render(<BoardCard ticket={makeTicket({ sla_ms: null })} />);
    const slaIndicator = container.querySelector("[data-testid='sla-indicator']");
    expect(slaIndicator).toBeNull();
  });
});
