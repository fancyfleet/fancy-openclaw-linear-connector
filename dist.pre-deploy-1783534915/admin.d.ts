import { Router } from "express";
import type { AgentQueue } from "./queue/index.js";
import type { PendingWorkBag } from "./bag/index.js";
import type { SessionTracker } from "./bag/index.js";
import type { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";
import type { OperationalEventStore } from "./store/operational-event-store.js";
import type { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";
import type { ObservationStore } from "./store/observation-store.js";
import { type WakeUpConfig } from "./bag/wake-up.js";
interface AdminDeps {
    agentQueue: AgentQueue;
    bag: PendingWorkBag;
    sessionTracker: SessionTracker;
    operationalEventStore?: OperationalEventStore;
    observationStore?: ObservationStore;
    ackTracker?: DispatchAckTracker;
    deploymentName: string;
    /** AI-1799: enrolled-tickets mirror for the /api/board endpoint. */
    enrolledTicketsStore?: EnrolledTicketsStore;
    /** If provided, set-state will re-dispatch to the new state's owner role (AI-1607). */
    wakeConfigForAgent?: (agentId: string) => WakeUpConfig;
    /** Override the SPA asset directory (tests). */
    webDistDir?: string;
    /** Override forensics diagnostics base directory (for testing, AI-1953). */
    forensicsDiagnosticsDir?: string;
}
export declare function createAdminRouter(deps: AdminDeps): Router;
export {};
//# sourceMappingURL=admin.d.ts.map