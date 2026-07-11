import { type Logger } from "../logger.js";
import { AlertStore, type AlertInput, type AlertSeverity } from "./alert-store.js";
export type { AlertInput, AlertSeverity };
export interface AlertBusOptions {
    store?: AlertStore;
    log?: Logger;
    /** Override push transport (tests). Default posts push_notification to the OpenClaw gateway. */
    pushFn?: (message: string) => Promise<string | void>;
    pushEnabled?: boolean;
    pushMinSeverity?: AlertSeverity;
    pushBudget?: number;
    now?: () => Date;
}
/**
 * The single funnel for "a human should know about this" (docs/alert-bus.md).
 *
 * notify() never throws and never blocks the caller beyond synchronous
 * log+store writes — it is safe to call from any error path. Sinks:
 *   log   — always
 *   store — always (alerts.db, the console's future event feed)
 *   push  — severity >= pushMinSeverity, storm-controlled
 */
export declare class AlertBus {
    private store;
    private log;
    private pushFn;
    private pushEnabled;
    private pushMinSeverity;
    private pushBudget;
    private pushTimestamps;
    private stormDigestSent;
    private suppressedDuringStorm;
    private now;
    constructor(options?: AlertBusOptions);
    notify(alert: AlertInput): void;
    private notifyInner;
    private sendPush;
    getStore(): AlertStore | null;
}
export declare function initAlertBus(options?: AlertBusOptions): AlertBus;
export declare function getAlertBus(): AlertBus;
export declare function notify(alert: AlertInput): void;
/** Test hook: reset the module singleton. */
export declare function _resetAlertBusForTests(): void;
//# sourceMappingURL=alert-bus.d.ts.map