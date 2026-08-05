/**
 * INF-1274 — createModuleLogger() de-duplication helper.
 *
 * AC under test (verbatim, captured at intake):
 *   - Add a single `createModuleLogger(name: string)` helper that internally
 *     handles the `LOG_LEVEL` env default and returns the component logger.
 *   - No change to actual log output/format/level behavior — pure
 *     de-duplication, not a logging-behavior change.
 *
 * Implementation home chosen by the test author per the AC's "suggested
 * home: linear-helpers.ts or a new small logging.ts" — this suite targets
 * a new `src/logging.ts` (keeps the helper import-light; linear-helpers.ts
 * is a large, unrelated Linear-API module and is itself one of the 93 call
 * sites being migrated). The implementer may relocate the export as long as
 * `createModuleLogger` remains importable from `./logging.js`.
 */
import { jest } from "@jest/globals";
import { componentLogger, createLogger } from "./logger.js";
import { createModuleLogger } from "./logging.js";

describe("INF-1274 AC: createModuleLogger(name) helper", () => {
  let originalLogLevel: string | undefined;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    originalLogLevel = process.env.LOG_LEVEL;
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
    errorSpy.mockRestore();
  });

  it("returns a Logger with info/error/warn/debug methods", () => {
    const log = createModuleLogger("my-module");
    expect(typeof log.info).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.debug).toBe("function");
  });

  it("defaults to LOG_LEVEL=info when the env var is unset — suppresses debug, emits info/warn/error", () => {
    delete process.env.LOG_LEVEL;
    const log = createModuleLogger("mod-a");

    log.debug("hidden");
    expect(errorSpy).not.toHaveBeenCalled();

    log.info("shown-info");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("[INFO]");
    expect(errorSpy.mock.calls[0][0]).toContain("[mod-a] shown-info");
  });

  it("respects LOG_LEVEL=debug from the env at construction time — emits debug messages", () => {
    process.env.LOG_LEVEL = "debug";
    const log = createModuleLogger("mod-b");

    log.debug("shown-debug");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("[DEBUG]");
    expect(errorSpy.mock.calls[0][0]).toContain("[mod-b] shown-debug");
  });

  it("respects LOG_LEVEL=error from the env — suppresses debug/info/warn", () => {
    process.env.LOG_LEVEL = "error";
    const log = createModuleLogger("mod-c");

    log.debug("x");
    log.info("y");
    log.warn("z");
    expect(errorSpy).not.toHaveBeenCalled();

    log.error("boom");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("prefixes every message with the component name, matching componentLogger's format", () => {
    process.env.LOG_LEVEL = "info";
    const log = createModuleLogger("prefix-check");

    log.warn("hello", { a: 1 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg] = errorSpy.mock.calls[0];
    expect(msg).toMatch(
      /^\[[^\]]+\] \[WARN\] \[connector\] \[prefix-check\] hello \[\{"a":1\}\]$/,
    );
  });

  it("produces byte-identical output to the manual componentLogger(createLogger(process.env.LOG_LEVEL ?? \"info\"), name) construction (no behavior change)", () => {
    process.env.LOG_LEVEL = "warn";
    const stripTimestamp = (s: string) => s.replace(/^\[[^\]]+\]/, "[TS]");

    const manual = componentLogger(
      createLogger(process.env.LOG_LEVEL ?? "info"),
      "compare-module",
    );
    manual.warn("test message", 1, 2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const manualOutput = stripTimestamp(errorSpy.mock.calls[0][0]);
    errorSpy.mockClear();

    const helper = createModuleLogger("compare-module");
    helper.warn("test message", 1, 2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const helperOutput = stripTimestamp(errorSpy.mock.calls[0][0]);

    expect(helperOutput).toBe(manualOutput);
  });

  it("produces byte-identical output to the manual componentLogger(createLogger(), name) construction (bare-call-site parity, no behavior change)", () => {
    delete process.env.LOG_LEVEL;
    const stripTimestamp = (s: string) => s.replace(/^\[[^\]]+\]/, "[TS]");

    const manual = componentLogger(createLogger(), "bare-compare-module");
    manual.error("bare test", { ok: true });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const manualOutput = stripTimestamp(errorSpy.mock.calls[0][0]);
    errorSpy.mockClear();

    const helper = createModuleLogger("bare-compare-module");
    helper.error("bare test", { ok: true });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const helperOutput = stripTimestamp(errorSpy.mock.calls[0][0]);

    expect(helperOutput).toBe(manualOutput);
  });
});
