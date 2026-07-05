/**
 * AI-1800 AC4 — Dispatches sub-view groups by wake_id and is labeled as
 * dispatch cycles, not tasks.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DispatchCyclesView } from "../pages/DispatchCyclesView";

export interface DispatchCycle {
  wake_id: string;
  agent_id: string;
  dispatches: Array<{
    ticket_id: string;
    dispatched_at: string;
    ack_status: string;
    attempt_count: number;
  }>;
}

export interface DispatchesResponse {
  label: string;
  cycles: DispatchCycle[];
}

const sampleData: DispatchesResponse = {
  label: "Dispatch cycles",
  cycles: [
    {
      wake_id: "wake-abc-001",
      agent_id: "igor",
      dispatches: [
        { ticket_id: "AI-4001", dispatched_at: "2026-07-05T14:00:00Z", ack_status: "pending", attempt_count: 1 },
      ],
    },
    {
      wake_id: "wake-abc-002",
      agent_id: "sage",
      dispatches: [
        { ticket_id: "AI-4002", dispatched_at: "2026-07-05T14:05:00Z", ack_status: "acknowledged", attempt_count: 1 },
        { ticket_id: "AI-4003", dispatched_at: "2026-07-05T14:05:00Z", ack_status: "pending", attempt_count: 2 },
      ],
    },
  ],
};

describe("AI-1800 AC4: DispatchCyclesView — grouped by wake_id", () => {
  it("renders the view labeled as dispatch cycles, not tasks", () => {
    render(<DispatchCyclesView data={sampleData} />);
    expect(screen.getByText(/dispatch cycle/i)).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for agent pickup/)).not.toBeInTheDocument();
  });

  it("renders one group per wake_id", () => {
    const { container } = render(<DispatchCyclesView data={sampleData} />);
    const groups = container.querySelectorAll("[data-testid='dispatch-cycle-group']");
    expect(groups.length).toBe(2);
  });

  it("each group shows the wake_id and agent_id", () => {
    render(<DispatchCyclesView data={sampleData} />);
    expect(screen.getByText(/wake-abc-001/)).toBeInTheDocument();
    expect(screen.getByText(/igor/)).toBeInTheDocument();
    expect(screen.getByText(/wake-abc-002/)).toBeInTheDocument();
    expect(screen.getByText(/sage/)).toBeInTheDocument();
  });

  it("dispatches within a cycle are nested under the group", () => {
    const { container } = render(<DispatchCyclesView data={sampleData} />);
    const secondGroup = container.querySelectorAll("[data-testid='dispatch-cycle-group']")[1];
    const dispatches = secondGroup.querySelectorAll("[data-testid='dispatch-entry']");
    expect(dispatches.length).toBe(2);
    expect(secondGroup).toHaveTextContent("AI-4002");
    expect(secondGroup).toHaveTextContent("AI-4003");
  });
});
