import { componentLogger, createLogger, type Logger } from "./logger.js";

/**
 * De-duplicates the `componentLogger(createLogger(...), name)` construction
 * that was repeated at every module's top-level logger declaration (INF-1274).
 *
 * Most call sites explicitly wired `createLogger(process.env.LOG_LEVEL ?? "info")`
 * and this is the default when `level` is omitted. A handful of call sites called
 * bare `createLogger()` instead, which — via that function's own default
 * parameter — is hardcoded to "info" regardless of `LOG_LEVEL` (this notably
 * differs under CI's `LOG_LEVEL=error`). Those sites pass `"info"` explicitly
 * here to preserve that exact pre-existing behavior; this is a pure
 * de-duplication, not a logging-behavior change.
 */
export function createModuleLogger(name: string, level?: string): Logger {
  return componentLogger(createLogger(level ?? process.env.LOG_LEVEL ?? "info"), name);
}
