export interface EnrollInput {
    ticketId: string;
    workflow: string;
    state: string;
    delegate: string | null;
}
export interface TransitionInput {
    ticketId: string;
    toState: string;
    delegate: string | null;
    eventKind: string;
}
export interface ReconcileLabels {
    name: string;
}
export interface ReconcileInput {
    labels: ReconcileLabels[];
    delegate: string | null;
    identifier: string;
}
export interface ReconcileResult {
    action: "created" | "corrected" | "noop" | "demoted";
}
export interface EnrolledTicketRow {
    ticket_id: string;
    workflow: string;
    state: string;
    delegate: string | null;
    entered_state_at: string;
    enrolled_at: string;
    last_event_kind: string | null;
    last_event_at: string | null;
    terminal: number;
}
export declare class EnrolledTicketsStore {
    private db;
    constructor(dbPath?: string);
    private migrate;
    /** AC1: Enroll a ticket into the mirror (idempotent). */
    enroll(input: EnrollInput): void;
    /** AC1: Record a proxy-applied state transition. */
    recordTransition(input: TransitionInput): void;
    /** AC1: Mark a ticket terminal (complete / validated / etc). */
    markTerminal(ticketId: string, eventKind: string): void;
    /** AC1: Mark a ticket as having left the workflow (demoted to ad-hoc). */
    demoteEnrolled(ticketId: string): void;
    /** Look up a single ticket by its identifier. */
    getByTicketId(ticketId: string): EnrolledTicketRow | null;
    /** Return all enrolled tickets (including terminal). */
    getAll(): EnrolledTicketRow[];
    /**
     * AC3: Reconcile the mirror against authoritative Linear label state.
     *
     * - No wf:* label → ticket left the workflow → mark terminal (demoted).
     * - wf:* but no state:* → not our defect (AI-1775's lane) → noop.
     * - wf:* + state:* but no mirror row → create (heal missing enrollment).
     * - Mirror row with stale state/delegate → correct.
     * - Match → noop.
     * - Terminal ticket with no wf:* → noop (already correctly terminal).
     */
    reconcile(ticketId: string, input: ReconcileInput): ReconcileResult;
    close(): void;
}
//# sourceMappingURL=enrolled-tickets-store.d.ts.map