/**
 * AI-1800 AC1 — Board renders columns from workflow YAML order.
 *
 * Frontend component test: BoardPage renders one column per workflow state,
 * in the order defined by the workflow YAML. Adding a new workflow def must
 * require zero UI code changes.
 *
 * These tests import from the implementation paths. They will fail to compile
 * until the components are created by the implementer.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BoardPage } from "../pages/BoardPage";
import type { BoardWorkflow, BoardTicket } from "../board-types";

const sampleWorkflows: BoardWorkflow[] = [
  {
    id: "dev-impl",
    states: ["intake", "write-tests", "implementation", "code-review", "deployment", "ac-validate", "done"],
  },
];

const sampleTickets: BoardTicket[] = [
  {
    ticket_id: "AI-1001",
    workflow: "dev-impl",
    state: "intake",
    delegate: "astrid",
    time_in_state_ms: 3600000,
    sla_ms: null,
    last_event_prose: "Astrid accepted the ticket, 1h ago",
    terminal: 0,
    muted: false,
  },
  {
    ticket_id: "AI-1002",
    workflow: "dev-impl",
    state: "write-tests",
    delegate: "tdd",
    time_in_state_ms: 7200000,
    sla_ms: 172800000,
    last_event_prose: "Test-driven development agent started, 2h ago",
    terminal: 0,
    muted: false,
  },
  {
    ticket_id: "AI-1003",
    workflow: "dev-impl",
    state: "done",
    delegate: "astrid",
    time_in_state_ms: 0,
    sla_ms: null,
    last_event_prose: "Validated and closed, just now",
    terminal: 1,
    muted: false,
    terminal_duration_ms: 600000,
  },
];

describe("AI-1800 AC1: BoardPage — workflow YAML column ordering", () => {
  it("renders a column for each state in the workflow YAML order", () => {
    const { container } = render(
      <BoardPage workflows={sampleWorkflows} tickets={sampleTickets} />,
    );

    const columns = container.querySelectorAll("[data-testid='board-column']");
    expect(columns.length).toBe(sampleWorkflows[0].states.length);

    expect(columns[0]).toHaveAttribute("data-column-state", "intake");
    expect(columns[columns.length - 1]).toHaveAttribute("data-column-state", "done");
  });

  it("places each ticket in the correct column matching its state", () => {
    render(
      <BoardPage workflows={sampleWorkflows} tickets={sampleTickets} />,
    );

    const intakeColumn = screen.getByTestId("board-column-intake");
    expect(intakeColumn).toHaveTextContent("AI-1001");

    const wtColumn = screen.getByTestId("board-column-write-tests");
    expect(wtColumn).toHaveTextContent("AI-1002");

    const doneColumn = screen.getByTestId("board-column-done");
    expect(doneColumn).toHaveTextContent("AI-1003");
  });

  it("renders columns for a synthetic workflow with zero code changes", () => {
    const syntheticWorkflow: BoardWorkflow[] = [
      { id: "synthetic-review", states: ["draft", "in-progress", "approved"] },
    ];

    const syntheticTickets: BoardTicket[] = [
      {
        ticket_id: "SYN-001",
        workflow: "synthetic-review",
        state: "in-progress",
        delegate: "reviewer",
        time_in_state_ms: 0,
        sla_ms: 86400000,
        last_event_prose: "Review started",
        terminal: 0,
        muted: false,
      },
    ];

    const { container } = render(
      <BoardPage workflows={syntheticWorkflow} tickets={syntheticTickets} />,
    );

    const columns = container.querySelectorAll("[data-testid='board-column']");
    expect(columns.length).toBe(3);
    expect(columns[0]).toHaveAttribute("data-column-state", "draft");
    expect(columns[1]).toHaveAttribute("data-column-state", "in-progress");
    expect(columns[2]).toHaveAttribute("data-column-state", "approved");
  });

  it("only renders workflows that have enrolled tickets", () => {
    const workflows: BoardWorkflow[] = [
      { id: "dev-impl", states: ["intake", "done"] },
      { id: "empty-workflow", states: ["a", "b", "c"] },
    ];

    const tickets: BoardTicket[] = [
      {
        ticket_id: "AI-1004",
        workflow: "dev-impl",
        state: "intake",
        delegate: "astrid",
        time_in_state_ms: 0,
        sla_ms: null,
        last_event_prose: "",
        terminal: 0,
        muted: false,
      },
    ];

    const { container } = render(
      <BoardPage workflows={workflows} tickets={tickets} />,
    );

    const columns = container.querySelectorAll("[data-testid='board-column']");
    expect(columns.length).toBe(2); // intake, done — empty-workflow excluded
  });
});
