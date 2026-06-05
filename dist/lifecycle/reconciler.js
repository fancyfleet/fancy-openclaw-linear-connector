import { createLogger, componentLogger } from "../logger.js";
import { resignalPendingTickets } from "../bag/resignal.js";
import { fetchDelegatedOpenIssues, resetTicketToTodo, postTicketComment, } from "./linear-query.js";
import { fetchOpenClawSessions, hasRecentExactTicketSession, } from "./openclaw-query.js";
const log = componentLogger(createLogger(), "lifecycle-reconciler");
export class LifecycleReconciler {
    constructor(store, bag, sessionTracker, config) {
        this.timer = null;
        this.cumulative = {
            runs: 0,
            wakeAttempts: 0,
            staleResets: 0,
            deadLetters: 0,
            activeSessionsMatched: 0,
            errors: 0,
            lastRunAt: null,
            lastCleanRunAt: null,
        };
        this.store = store;
        this.bag = bag;
        this.sessionTracker = sessionTracker;
        this.linearToken = config.linearToken;
        this.thresholdMin = config.thresholdMin ?? 25;
        this.cooldownMin = config.cooldownMin ?? 90;
        this.activeWindowMin = config.activeWindowMin ?? 180;
        this.maxDeadLetterResets = config.maxDeadLetterResets ?? 3;
        this.hooksUrl = config.hooksUrl;
        this.hooksToken = config.hooksToken;
        this.hooksThinking = config.hooksThinking;
        this.hooksModel = config.hooksModel;
        this.openclawBin = config.openclawBin;
    }
    start(intervalMs = 5 * 60 * 1000) {
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            this.runOnce().catch((err) => {
                log.error(`Reconciler run failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        }, intervalMs);
        this.timer.unref();
        log.info(`Lifecycle reconciler started (intervalMs=${intervalMs})`);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            log.info("Lifecycle reconciler stopped");
        }
    }
    async runOnce() {
        const ranAt = new Date().toISOString();
        const result = {
            freshSessions: 0,
            normalBacklog: 0,
            cooldown: 0,
            waitingOnHuman: 0,
            wakeAttempts: 0,
            staleResets: 0,
            deadLetters: 0,
            errors: [],
            clean: false,
            ranAt,
        };
        if (!this.linearToken) {
            log.warn("Lifecycle reconciler: no linearToken configured, skipping run");
            result.clean = true;
            this.cumulative.runs++;
            this.cumulative.lastRunAt = ranAt;
            this.cumulative.lastCleanRunAt = ranAt;
            return result;
        }
        const wakeConfig = {
            nodeBin: process.execPath,
            hooksUrl: this.hooksUrl,
            hooksToken: this.hooksToken,
            hooksThinking: this.hooksThinking,
            hooksModel: this.hooksModel,
            timeoutMs: process.env.NODE_ENV === "test" ? 50 : undefined,
            maxRetries: process.env.NODE_ENV === "test" ? 0 : undefined,
        };
        let tickets;
        let sessions;
        try {
            tickets = await fetchDelegatedOpenIssues(this.linearToken);
        }
        catch (err) {
            const msg = `fetchDelegatedOpenIssues failed: ${err instanceof Error ? err.message : String(err)}`;
            log.error(msg);
            result.errors.push(msg);
            this.cumulative.errors++;
            this.cumulative.runs++;
            this.cumulative.lastRunAt = ranAt;
            return result;
        }
        try {
            sessions = await fetchOpenClawSessions(this.activeWindowMin, this.openclawBin);
        }
        catch (err) {
            const msg = `fetchOpenClawSessions failed: ${err instanceof Error ? err.message : String(err)}`;
            log.error(msg);
            result.errors.push(msg);
            this.cumulative.errors++;
            this.cumulative.runs++;
            this.cumulative.lastRunAt = ranAt;
            return result;
        }
        const now = Date.now();
        for (const ticket of tickets) {
            try {
                // a. Skip if waiting on human (assignee set)
                if (ticket.assigneeName !== null) {
                    result.waitingOnHuman++;
                    continue;
                }
                // b/c. Skip if below stale threshold
                const ageMin = ticket.ageMs / 60000;
                if (ageMin < this.thresholdMin) {
                    result.normalBacklog++;
                    continue;
                }
                // d. Skip if agent has a fresh session for this ticket
                if (hasRecentExactTicketSession(sessions, ticket.delegateAgentId, ticket.identifier, this.thresholdMin)) {
                    result.freshSessions++;
                    this.cumulative.activeSessionsMatched++;
                    continue;
                }
                // e. Check cooldown
                const wakeRecord = this.store.getWakeRecord(ticket.delegateAgentId, ticket.identifier);
                const lastWake = wakeRecord?.lastWakeSentAt ?? null;
                const inCooldown = lastWake !== null &&
                    now - lastWake < this.cooldownMin * 60 * 1000;
                if (inCooldown) {
                    result.cooldown++;
                    continue;
                }
                // f. Skip if already dead-lettered
                if (wakeRecord?.deadLetteredAt) {
                    result.deadLetters++;
                    continue;
                }
                // g. Dead-letter if reset count exhausted
                const resetCount = wakeRecord?.resetCount ?? 0;
                if (resetCount >= this.maxDeadLetterResets) {
                    this.store.markDeadLetter(ticket.delegateAgentId, ticket.identifier, now);
                    result.deadLetters++;
                    this.cumulative.deadLetters++;
                    continue;
                }
                // h. Reset to To Do if stuck in Thinking or Doing
                if (ticket.state === "Thinking" || ticket.state === "Doing") {
                    try {
                        await resetTicketToTodo(ticket.uuid, ticket.teamId, this.linearToken);
                        await postTicketComment(ticket.uuid, `Lifecycle reconciler reset: ticket was in ${ticket.state} for ${ticket.delegateAgentId} with no fresh session past threshold (${this.thresholdMin}m). Resetting to To Do for next wake-up pass.`, this.linearToken);
                        this.store.recordReset(ticket.delegateAgentId, ticket.identifier, now);
                        result.staleResets++;
                        this.cumulative.staleResets++;
                        log.warn(`Stale reset: ${ticket.identifier} (${ticket.state}) for ${ticket.delegateAgentId}`);
                    }
                    catch (err) {
                        const msg = `Reset failed for ${ticket.identifier}: ${err instanceof Error ? err.message : String(err)}`;
                        log.error(msg);
                        result.errors.push(msg);
                        this.cumulative.errors++;
                    }
                }
                // i. Send wake-up signal
                this.bag.add(ticket.delegateAgentId, ticket.identifier, "lifecycle-rescue");
                try {
                    await resignalPendingTickets(ticket.delegateAgentId, [ticket.identifier], this.bag, this.sessionTracker, wakeConfig, { markActive: false });
                }
                catch (err) {
                    log.error(`resignalPendingTickets error for ${ticket.identifier}: ${err instanceof Error ? err.message : String(err)}`);
                }
                this.store.recordWakeSent(ticket.delegateAgentId, ticket.identifier, now);
                result.wakeAttempts++;
                this.cumulative.wakeAttempts++;
            }
            catch (err) {
                const msg = `Error processing ${ticket.identifier}: ${err instanceof Error ? err.message : String(err)}`;
                log.error(msg);
                result.errors.push(msg);
                this.cumulative.errors++;
            }
        }
        result.clean =
            result.wakeAttempts +
                result.staleResets +
                result.deadLetters +
                result.errors.length ===
                0;
        this.cumulative.runs++;
        this.cumulative.lastRunAt = ranAt;
        if (result.clean) {
            this.cumulative.lastCleanRunAt = ranAt;
        }
        if (!result.clean) {
            log.warn(`Reconcile run: freshSessions=${result.freshSessions} normalBacklog=${result.normalBacklog} staleResets=${result.staleResets} wakeAttempts=${result.wakeAttempts} deadLetters=${result.deadLetters} errors=${result.errors.length}`);
        }
        return result;
    }
    getMetrics() {
        return { ...this.cumulative };
    }
}
//# sourceMappingURL=reconciler.js.map