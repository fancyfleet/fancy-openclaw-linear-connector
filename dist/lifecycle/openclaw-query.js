import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger, componentLogger } from "../logger.js";
const log = componentLogger(createLogger(), "lifecycle-openclaw");
const execFileAsync = promisify(execFile);
function resolveOpenclawBin(openclawBin) {
    if (openclawBin)
        return openclawBin;
    if (process.env.OPENCLAW_BIN)
        return process.env.OPENCLAW_BIN;
    return (`${process.env.HOME}/.nvm/versions/node/v24.15.0/bin/openclaw`);
}
export async function fetchOpenClawSessions(activeWindowMin, openclawBin) {
    const bin = resolveOpenclawBin(openclawBin);
    try {
        const { stdout } = await execFileAsync(bin, [
            "sessions",
            "--all-agents",
            "--active",
            String(activeWindowMin),
            "--json",
        ]);
        const parsed = JSON.parse(stdout);
        const sessions = parsed.sessions ?? [];
        return sessions
            .filter((s) => typeof s.key === "string" &&
            typeof s.agentId === "string" &&
            typeof s.updatedAt === "number")
            .map((s) => ({
            key: s.key,
            agentId: s.agentId,
            updatedAt: s.updatedAt,
        }));
    }
    catch (err) {
        log.warn(`fetchOpenClawSessions failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}
export function hasRecentExactTicketSession(sessions, agentId, ticketId, thresholdMin) {
    const needle = `agent:${agentId}:linear-${ticketId.toLowerCase()}`;
    const cutoffMs = Date.now() - thresholdMin * 60 * 1000;
    return sessions.some((s) => s.agentId === agentId &&
        s.key === needle &&
        s.updatedAt >= cutoffMs);
}
//# sourceMappingURL=openclaw-query.js.map