import 'dotenv/config';
import { OperationalEventStore } from "./store/operational-event-store.js";
import { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";
import { ObservationStore } from "./store/observation-store.js";
import { ManagingStateStore } from "./store/managing-state-store.js";
import { AgentQueue } from "./queue/index.js";
import { DispatchDeliveryScheduler } from "./delivery/index.js";
import { PendingWorkBag, SessionTracker, DispatchAckTracker, DispatchWatchdog, NoActivityDetector, HoldRetryTracker, ManagingPoller } from "./bag/index.js";
import { type WakeUpConfig } from "./bag/wake-up.js";
import { MutationAuditStore } from "./store/mutation-audit-store.js";
import { DispatchIdempotencyStore } from "./store/dispatch-idempotency-store.js";
export interface CreateAppOptions {
    /** Override PendingWorkBag database path (for testing). */
    bagDbPath?: string;
    /** Override AgentQueue database path (for testing). */
    agentQueueDbPath?: string;
    /** Override OperationalEventStore database path (for testing). */
    operationalEventsDbPath?: string;
    /** Override ObservationStore database path (for testing). */
    observationsDbPath?: string;
    /** Override ManagingStateStore database path (for testing). */
    managingStateDbPath?: string;
    /** Override EnrolledTicketsStore database path (for testing). */
    enrolledTicketsDbPath?: string;
    /** Override MutationAuditStore database path (for testing). AI-1838. */
    mutationAuditDbPath?: string;
    /** Override DispatchIdempotencyStore database path (for testing). AI-1918. */
    idempotencyDbPath?: string;
    /** Override forensics diagnostics base directory (for testing, AI-1953). */
    forensicsDiagnosticsDir?: string;
    /**
     * Test hook: override wake-up delivery for resignal/hold-retry dispatches.
     * When provided, replaces the real sendWakeUpSignal so tests don't hit the
     * live hooks URL. Also used as isTicketActionable bypass when provided.
     */
    sendWakeUp?: (agentId: string, ticketIds: string[]) => Promise<void>;
}
export declare function createApp(options?: CreateAppOptions): {
    app: import("express-serve-static-core").Express;
    agentQueue: AgentQueue;
    bag: PendingWorkBag;
    sessionTracker: SessionTracker;
    operationalEventStore: OperationalEventStore;
    enrolledTicketsStore: EnrolledTicketsStore;
    observationStore: ObservationStore;
    wakeConfig: {
        nodeBin: string;
        hooksUrl: string | undefined;
        hooksToken: string | undefined;
        hooksThinking: string | undefined;
        hooksModel: string | undefined;
        timeoutMs: number | undefined;
        maxRetries: number | undefined;
    };
    wakeConfigForAgent: (agentIdLookup: string) => WakeUpConfig;
    resignalOptions: {
        isTicketActionable?: (() => boolean | Promise<boolean>) | undefined;
        sendWakeUp: (agentId: string, ticketIds: string[]) => Promise<void | {
            runId?: string;
            canonVersion?: string;
        }>;
    };
    ackTracker: DispatchAckTracker;
    dispatchDeliveryScheduler: DispatchDeliveryScheduler;
    watchdog: DispatchWatchdog;
    noActivityDetector: NoActivityDetector;
    holdRetryTracker: HoldRetryTracker;
    managingPoller: ManagingPoller;
    managingStateStore: ManagingStateStore;
    mutationAuditStore: MutationAuditStore;
    idempotencyStore: DispatchIdempotencyStore;
};
//# sourceMappingURL=index.d.ts.map