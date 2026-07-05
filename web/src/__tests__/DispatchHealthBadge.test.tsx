/**
 * AI-1801 — BoardCard renders dispatch-health badge for all six states.
 *
 * AC1: Badge state computed server-side (tested in backend). This test verifies
 *      the frontend renders the badge correctly with the right data-testid,
 *      data-badge-state, and label text including attempt N/3 for unconfirmed.
 * AC3: Badge updates on board refresh (live poll re-renders).
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BoardCard } from "../components/BoardCard";
import type { BoardTicket, DispatchHealth } from "../board-types";

function makeTicket(overrides: Partial<BoardTicket> = {}): BoardTicket {
  return {
    ticket_id: "AI-2001",
    workflow: "dev-impl",
    state: "implementation",
    delegate: "igor",
    time_in_state_ms: 0,
    sla_ms: 259200000,
    last_event_prose: "Igor started implementation, just now",
    terminal: 0,
    muted: false,
    ...overrides,
  };
}

function makeHealth(badge: DispatchHealth["badge"], attempt: number | null = null): DispatchHealth {
  return { badge, attempt, maxAttempts: 3 };
}

describe("AI-1801: BoardCard dispatch-health badge", () => {
  it("does not render badge when dispatch_health is absent (backward compat)", () => {
    const { container } = render(<BoardCard ticket={makeTicket()} />);
    expect(container.querySelector("[data-testid='dispatch-health-badge']")).toBeNull();
  });

  it("renders working badge", () => {
    render(<BoardCard ticket={makeTicket({ dispatch_health: makeHealth("working") })} />);
    const badge = screen.getByTestId("dispatch-health-badge");
    expect(badge).toHaveAttribute("data-badge-state", "working");
    expect(badge).toHaveTextContent("Working");
  });

  it("renders quiet badge", () => {
    render(<BoardCard ticket={makeTicket({ dispatch_health: makeHealth("quiet") })} />);
    const badge = screen.getByTestId("dispatch-health-badge");
    expect(badge).toHaveAttribute("data-badge-state", "quiet");
    expect(badge).toHaveTextContent("Quiet");
  });

  it("renders unconfirmed badge with attempt N/3", () => {
    render(
      <BoardCard ticket={makeTicket({ dispatch_health: makeHealth("unconfirmed", 2) })} />,
    );
    const badge = screen.getByTestId("dispatch-health-badge");
    expect(badge).toHaveAttribute("data-badge-state", "unconfirmed");
    expect(badge).toHaveTextContent("Unconfirmed 2/3");
  });

  it("renders exhausted badge", () => {
    render(<BoardCard ticket={makeTicket({ dispatch_health: makeHealth("exhausted", 4) })} />);
    const badge = screen.getByTestId("dispatch-health-badge");
    expect(badge).toHaveAttribute("data-badge-state", "exhausted");
    expect(badge).toHaveTextContent("Exhausted");
  });

  it("renders at-capacity badge", () => {
    render(
      <BoardCard ticket={makeTicket({ dispatch_health: makeHealth("at-capacity") })} />,
    );
    const badge = screen.getByTestId("dispatch-health-badge");
    expect(badge).toHaveAttribute("data-badge-state", "at-capacity");
    expect(badge).toHaveTextContent("At capacity");
  });

  it("renders idle badge", () => {
    render(<BoardCard ticket={makeTicket({ dispatch_health: makeHealth("idle") })} />);
    const badge = screen.getByTestId("dispatch-health-badge");
    expect(badge).toHaveAttribute("data-badge-state", "idle");
    expect(badge).toHaveTextContent("Idle");
  });

  it("badge renders alongside existing SLA indicator", () => {
    const { container } = render(
      <BoardCard
        ticket={makeTicket({
          time_in_state_ms: 86400000,
          sla_ms: 259200000,
          dispatch_health: makeHealth("working"),
        })}
      />,
    );
    expect(container.querySelector("[data-testid='sla-indicator']")).toBeTruthy();
    expect(container.querySelector("[data-testid='dispatch-health-badge']")).toBeTruthy();
  });
});
