import { componentLogger, createLogger, type Logger } from "./logger.js";

/**
 * De-duplicates the `componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), name)`
 * construction that was repeated at every module's top-level logger declaration (INF-1274).
 */
export function createModuleLogger(name: string): Logger {
  return componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), name);
}
