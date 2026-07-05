/**
 * AI-1800 AC3 — Terminal tickets render in the Done column for 24h with
 * completion duration; cancelled/demoted render in the muted sub-strip.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BoardCard } from "../components/BoardCard";
import { BoardPage } from "../pages/BoardPage";
import type { BoardTicket } from "../board-types";

function terminalTicket(overrides: Partial<BoardTicket> = {}): BoardTicket {
  return {
    ticket_id: "AI-3001",
    workflow: "dev-impl",
    state: "done",
    delegate: "astrid",
    time_in_state_ms: 0,
    sla_ms: null,
    last_event_prose: "Validated and closed",
    terminal: 1,
    muted: false,
    terminal_duration_ms: 3600000,
    ...overrides,
  };
}

describe("AI-1800 AC3: Terminal tickets — Done column rendering and muted sub-strip", () => {
  it("terminal ticket shows completion duration on the card", () => {
    render(<BoardCard ticket={terminalTicket({ terminal_duration_ms: 13200000 })} />);
    const durationEl = screen.getByTestId("completion-duration");
    expect(durationEl).toBeInTheDocument();
    expect(durationEl).toHaveTextContent(/3h/);
  });

  it("demoted/muted ticket renders with muted styling", () => {
    const { container } = render(
      <BoardCard ticket={terminalTicket({ muted: true, state: "intake" })} />,
    );
    const card = container.querySelector("[data-testid='board-card']");
    expect(card).toHaveAttribute("data-muted", "true");
  });

  it("active (non-muted) ticket does not have muted attribute", () => {
    const ticket: BoardTicket = {
      ticket_id: "AI-3002",
      workflow: "dev-impl",
      state: "implementation",
      delegate: "igor",
      time_in_state_ms: 0,
      sla_ms: 259200000,
      last_event_prose: "Working",
      terminal: 0,
      muted: false,
    };
    const { container } = render(<BoardCard ticket={ticket} />);
    const card = container.querySelector("[data-testid='board-card']");
    expect(card?.getAttribute("data-muted")).toBeFalsy();
  });

  it("board page renders a muted sub-strip below the Done column for demoted tickets", () => {
    const workflows = [{ id: "dev-impl", states: ["intake", "done"] }];
    const tickets: BoardTicket[] = [
      {
        ticket_id: "AI-3003",
        workflow: "dev-impl",
        state: "done",
        delegate: "astrid",
        time_in_state_ms: 0,
        sla_ms: null,
        last_event_prose: "Closed",
        terminal: 1,
        muted: false,
        terminal_duration_ms: 1000000,
      },
      {
        ticket_id: "AI-3004",
        workflow: "dev-impl",
        state: "intake",
        delegate: null,
        time_in_state_ms: 0,
        sla_ms: null,
        last_event_prose: "Demoted from workflow",
        terminal: 0,
        muted: true,
      },
    ];

    const { container } = render(
      <BoardPage workflows={workflows} tickets={tickets} />,
    );

    const mutedStrip = container.querySelector("[data-testid='muted-sub-strip']");
    expect(mutedStrip).toBeInTheDocument();
    expect(mutedStrip).toHaveTextContent("AI-3004");
  });
});
