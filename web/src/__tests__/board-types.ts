/**
 * AI-1800 AC1 — Board type definitions.
 *
 * These types define the contract between the board API and the frontend.
 * The implementer must conform to these shapes.
 */

export interface BoardWorkflow {
  /** Workflow ID matching the YAML def's `id` field. */
  id: string;
  /** Ordered list of state IDs from the YAML `states:` list. */
  states: string[];
}

export interface BoardTicket {
  ticket_id: string;
  workflow: string;
  state: string;
  delegate: string | null;
  /** Milliseconds since entered_state_at. */
  time_in_state_ms: number;
  /** SLA threshold in ms for the current state, or null if no SLA declared. */
  sla_ms: number | null;
  /** Rendered prose for the last event, e.g. "Igor accepted dispatch, 4m ago". */
  last_event_prose: string;
  /** 1 if ticket is in a terminal disposition. */
  terminal: number;
  /** True if demoted/cancelled — rendered in muted sub-strip. */
  muted: boolean;
  /** Milliseconds since terminal disposition (AC3). */
  terminal_duration_ms?: number;
}
