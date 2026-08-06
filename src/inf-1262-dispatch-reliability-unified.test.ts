/**
 * INF-1262 — unified dispatch-reliability controller.
 *
 * These are intentionally failing contract tests for the consolidation work:
 * the implementation must introduce `DispatchReliabilityController` as the
 * single owner of circuit-breaker, redispatch-budget, stuck-delegate detection,
 * wake-policy enforcement, and acked dispatch delivery routing.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jest } from "@jest/globals";
import type { SchedulerDispatchParams } from "./delivery/dispatch-delivery-scheduler.js";
import type { DeliverWithAckOutcome } from "./delivery/deliver-with-ack.js";
import type { DeliveryResult } from "./delivery/deliver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");
const CONTROLLER_MODULE = "./dispatch-reliability-controller.js";

type WakePolicyResult = { allowed: boolean; reason: string | null };
type BreakerResult = { shouldAlert: boolean; wakeCount: number; reason: string | null };
type ControllerLiveness = Record<string, any>;

interface DispatchReliabilityControllerLike {
  start(): void;
  stop(): void;
  recordWake(ticketId: string, labels: string[]): void;
  recordDelegateActivity(ticketId: string): void;
  evaluateBreaker(ticketId: string): BreakerResult;
  resetBreaker(ticketId: string): boolean;
  checkBreaker(ticketId: string): { blocked: boolean };
  recordStuckPrompt(ticketId: string): void;
  getStuckPromptCount(ticketId: string): number;
  dispatchWithAck(params: SchedulerDispatchParams): Promise<DeliverWithAckOutcome>;
  enforceWakePolicy(ticketId: string, labels: string[]): WakePolicyResult;
  liveness(): ControllerLiveness;
}

interface DispatchReliabilityControllerDeps {
  dispatchDeliveryScheduler: {
    start: jest.Mock;
    stop: jest.Mock;
    dispatch: jest.Mock<Promise<DeliverWithAckOutcome>, [SchedulerDispatchParams]>;
    liveness: jest.Mock;
  };
  maxConsecutiveWakes: number;
  redispatchBudgetPerTicket: number;
  maxStuckPromptsPerTicket: number;
  wakePolicySubscribers: string[];
  delegateClearRecoveryMaxLatencyMs: number;
  recoverDelegateClearInline: jest.Mock;
  hourlyRescueSweep: { run: jest.Mock };
  fireAndForgetWake: jest.Mock;
}

const governedLabels = ["wf:dev-impl", "state:implementation"];
const deliveredOutcome: DeliverWithAckOutcome = {
  status: "delivered",
  attempts: 1,
  dispatchId: "dispatch-inf-1262",
};

function createDeps(
  outcome: DeliverWithAckOutcome = deliveredOutcome,
): DispatchReliabilityControllerDeps {
  return {
    dispatchDeliveryScheduler: {
      start: jest.fn(),
      stop: jest.fn(),
      dispatch: jest.fn(async () => outcome),
      liveness: jest.fn(() => ({ schedulerActive: true, pendingRetries: 0 })),
    },
    maxConsecutiveWakes: 3,
    redispatchBudgetPerTicket: 2,
    maxStuckPromptsPerTicket: 2,
    wakePolicySubscribers: [
      "governed-transition",
      "stuck-delegate-reprompt",
      "delegate-clear-recovery",
      "reconciliation-wake",
    ],
    delegateClearRecoveryMaxLatencyMs: 30_000,
    recoverDelegateClearInline: jest.fn(async () => ({ recovered: true })),
    hourlyRescueSweep: { run: jest.fn() },
    fireAndForgetWake: jest.fn(),
  };
}

async function createController(
  deps = createDeps(),
): Promise<{ controller: DispatchReliabilityControllerLike; deps: DispatchReliabilityControllerDeps }> {
  const mod = await import(CONTROLLER_MODULE);
  const Controller = (mod as {
    DispatchReliabilityController: new (
      deps: DispatchReliabilityControllerDeps,
    ) => DispatchReliabilityControllerLike;
  }).DispatchReliabilityController;
  return { controller: new Controller(deps), deps };
}

function dispatchParams(overrides: Partial<SchedulerDispatchParams> = {}): SchedulerDispatchParams {
  const ok: DeliveryResult = { dispatched: true, runId: "run-inf-1262" };
  return {
    agentId: "igor",
    ticketId: "AI-1262",
    workflowState: "implementation",
    gateway: "grover",
    dispatchId: "dispatch-inf-1262",
    deliver: async () => ok,
    maxRetries: 2,
    backoffMs: (attempt) => attempt * 10,
    sleep: async () => undefined,
    ...overrides,
  };
}

describe("INF-1262 AC1: unified controller owns circuit-breaker + redispatch-budget + stuck-delegate detection", () => {
  test("one controller coordinates breaker state, redispatch budget, and stuck prompt counts", async () => {
    const { controller } = await createController();

    controller.start();
    controller.recordWake("AI-1262", governedLabels);
    controller.recordWake("AI-1262", governedLabels);
    controller.recordWake("AI-1262", governedLabels);
    controller.recordStuckPrompt("AI-1262");
    controller.recordStuckPrompt("AI-1262");

    expect(controller.evaluateBreaker("AI-1262")).toEqual(
      expect.objectContaining({
        shouldAlert: true,
        wakeCount: 3,
      }),
    );
    expect(controller.checkBreaker("AI-1262")).toEqual({ blocked: true });
    expect(controller.getStuckPromptCount("AI-1262")).toBe(2);
    expect(controller.enforceWakePolicy("AI-1262", governedLabels)).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: expect.stringMatching(/breaker|budget|stuck/i),
      }),
    );

    const liveness = controller.liveness();
    expect(liveness).toEqual(
      expect.objectContaining({
        active: true,
        controllerRegistered: true,
        circuitBreaker: expect.objectContaining({ active: true, owner: "dispatch-reliability-controller" }),
        redispatchBudget: expect.objectContaining({ active: true, owner: "dispatch-reliability-controller" }),
        stuckDelegateDetection: expect.objectContaining({ active: true, owner: "dispatch-reliability-controller" }),
      }),
    );
  });
});

describe("INF-1262 AC2: wake-policy enforced in a single shared delivery primitive", () => {
  test("dispatchWithAck performs the mandatory wake-policy pre-flight before scheduling delivery", async () => {
    const { controller, deps } = await createController();
    controller.recordWake("AI-1262", governedLabels);
    controller.recordWake("AI-1262", governedLabels);
    controller.recordWake("AI-1262", governedLabels);

    await expect(controller.dispatchWithAck(dispatchParams())).rejects.toThrow(
      /wake.?policy|circuit.?breaker|blocked/i,
    );
    expect(deps.dispatchDeliveryScheduler.dispatch).not.toHaveBeenCalled();
    expect(deps.fireAndForgetWake).not.toHaveBeenCalled();

    expect(controller.resetBreaker("AI-1262")).toBe(true);
    await expect(controller.dispatchWithAck(dispatchParams())).resolves.toEqual(deliveredOutcome);
    expect(deps.dispatchDeliveryScheduler.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("INF-1262 AC3: governed-transition wakes route through the acked delivery scheduler", () => {
  test("a governed transition delegates delivery to DispatchDeliveryScheduler instead of fire-and-forget wake", async () => {
    const retryingOutcome: DeliverWithAckOutcome = {
      status: "delivered",
      attempts: 2,
      dispatchId: "dispatch-transition-1262",
    };
    const { controller, deps } = await createController(createDeps(retryingOutcome));
    const params = dispatchParams({
      ticketId: "AI-1262",
      workflowState: "code-review",
      dispatchId: "dispatch-transition-1262",
    });

    const outcome = await controller.dispatchWithAck(params);

    expect(outcome).toEqual(retryingOutcome);
    expect(deps.dispatchDeliveryScheduler.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: "AI-1262",
        agentId: "igor",
        workflowState: "code-review",
        dispatchId: "dispatch-transition-1262",
      }),
    );
    expect(deps.fireAndForgetWake).not.toHaveBeenCalled();
  });
});

describe("INF-1262 AC4: delegate-clear tickets recover inline with bounded latency", () => {
  test("delegate-clear recovery is inline and does not wait for the hourly rescue-sweep", async () => {
    const { controller, deps } = await createController();
    const params = {
      ...dispatchParams({
        ticketId: "AI-1262",
        workflowState: "implementation",
      }),
      labels: governedLabels,
      delegateCleared: true,
    } as SchedulerDispatchParams & { labels: string[]; delegateCleared: boolean };

    const outcome = await controller.dispatchWithAck(params);

    expect(outcome.status).toBe("delivered");
    expect(deps.recoverDelegateClearInline).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: "AI-1262", labels: governedLabels }),
    );
    expect(deps.dispatchDeliveryScheduler.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.hourlyRescueSweep.run).not.toHaveBeenCalled();
    expect(controller.liveness().delegateClearRecovery).toEqual(
      expect.objectContaining({
        mode: "inline",
        maxLatencyMs: expect.any(Number),
      }),
    );
    expect(controller.liveness().delegateClearRecovery.maxLatencyMs).toBeLessThanOrEqual(60_000);
  });
});

describe("INF-1262 AC5: regression paths verify governed transitions reliably wake delegates", () => {
  test("governed transition wake returns the acked scheduler outcome and records breaker progress", async () => {
    const { controller, deps } = await createController();
    const params = dispatchParams({
      ticketId: "AI-1262",
      workflowState: "validation",
      dispatchId: "dispatch-governed-transition",
    });

    expect(controller.enforceWakePolicy("AI-1262", ["wf:dev-impl", "state:validation"])).toEqual({
      allowed: true,
      reason: null,
    });

    const outcome = await controller.dispatchWithAck(params);
    controller.recordDelegateActivity("AI-1262");

    expect(outcome).toEqual(deliveredOutcome);
    expect(deps.dispatchDeliveryScheduler.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.dispatchDeliveryScheduler.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "igor",
        ticketId: "AI-1262",
        workflowState: "validation",
      }),
    );
    expect(controller.evaluateBreaker("AI-1262")).toEqual(
      expect.objectContaining({
        shouldAlert: false,
        reason: expect.stringMatching(/activity|progress|delegate/i),
      }),
    );
  });
});

const sampleAgent = {
  name: "igor",
  linearUserId: "user-igor-12345678",
  openclawAgent: "igor",
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  host: "local" as const,
};

async function pollHealth(url: string, timeoutMs: number): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = new Error("never attempted");
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const json = (await res.json()) as Record<string, any>;
      if (json && typeof json === "object") return json;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastErr;
}

/**
 * Poll a JSON file written by the `--import` listen-port probe below until it
 * carries a real bound port.
 */
async function pollBoundPort(portFile: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = new Error("port file was never written");
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(portFile, "utf8")) as { port?: number };
      if (typeof parsed.port === "number" && parsed.port > 0) return parsed.port;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastErr;
}

/**
 * `PORT=0` (ephemeral, OS-assigned) instead of a formulaic fixed port. Under
 * the full suite, ~20 other test files spawn this SAME dist/index.js entry
 * point concurrently across jest workers; a `4700 + pid%200 + rand(100)`
 * formula (the previous approach here) can collide with another worker's
 * server, leaving one instance stuck retrying its `listen()` call — its
 * cron/heartbeat timers still armed — well past this test's own teardown,
 * which is consistent with the "active timers" leak into a later test file
 * flagged in review. Mirrors the same `--import` net.Server.listen probe
 * inf-784-dept-engine.test.ts already uses for this exact reason.
 */
function writeListenPortProbe(tmpDir: string): { preload: string; portFile: string; envVar: string } {
  const portFile = path.join(tmpDir, "bound-port.json");
  const preload = path.join(tmpDir, "record-listen-port.mjs");
  const envVar = "INF1262_LISTEN_PORT_FILE";
  fs.writeFileSync(
    preload,
    `
import fs from "node:fs";
import net from "node:net";

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
  const result = originalListen.apply(this, args);
  this.once("listening", () => {
    const address = this.address();
    if (address && typeof address === "object" && address.port > 0) {
      fs.writeFileSync(
        process.env.${envVar},
        JSON.stringify({ port: address.port }),
        "utf8",
      );
    }
  });
  return result;
};
`,
    "utf8",
  );
  return { preload, portFile, envVar };
}

interface EntryPointHarness {
  dir: string;
  port: number;
  child: ChildProcess;
  stderr: () => string;
}

async function startEntryPoint(prefix: string): Promise<EntryPointHarness> {
  if (!fs.existsSync(DIST_ENTRY)) {
    throw new Error(
      `dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` before jest (CI does; see ci.yml)`,
    );
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const agentsFile = path.join(dir, "agents.json");
  const { preload, portFile, envVar } = writeListenPortProbe(dir);
  let childStderr = "";
  fs.writeFileSync(agentsFile, JSON.stringify({ agents: [sampleAgent] }), "utf8");

  const child = spawn(process.execPath, [DIST_ENTRY], {
    cwd: dir,
    env: {
      ...process.env,
      AGENTS_FILE: agentsFile,
      DATA_DIR: path.join(dir, "data"),
      PORT: "0",
      [envVar]: portFile,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${preload}`.trim(),
      LOG_LEVEL: "error",
      LINEAR_WEBHOOK_SECRET: process.env.LINEAR_WEBHOOK_SECRET ?? "test-secret",
      LINEAR_OAUTH_TOKEN: "test-linear-oauth-token",
      // AI-2420: this connector's own delivery config resolves hooksUrl from
      // agents.json, not this env var — the previous same-port
      // "/nonexistent-hooks" self-target only worked because the fixed port
      // was known before spawn. With PORT=0 the port isn't known yet, so
      // point at the conventional unused discard port instead (matches
      // inf-784-dept-engine.test.ts).
      OPENCLAW_HOOKS_URL: "http://127.0.0.1:9/nonexistent-hooks",
      OPENCLAW_HOOKS_TOKEN: "test-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    childStderr += chunk.toString("utf8");
  });

  const port = await pollBoundPort(portFile, 30_000).catch((err) => {
    throw new Error(
      `entry point never bound a listen port: ${err instanceof Error ? err.message : String(err)}\nchild stderr:\n${childStderr}`,
    );
  });

  return { dir, port, child, stderr: () => childStderr };
}

async function stopEntryPoint(harness: EntryPointHarness | undefined): Promise<void> {
  if (!harness) return;
  if (harness.child.exitCode === null && harness.child.signalCode === null) {
    // Always wait for the real "exit" event, even after escalating to
    // SIGKILL — resolving as soon as kill() is CALLED (rather than once the
    // process has actually terminated) can return control to the next test
    // file while this entry point is still releasing its port and tearing
    // down its own cron/heartbeat timers, which is exactly the kind of
    // cross-test-file contention under the full suite this harness must not
    // cause (review finding on this file).
    await new Promise<void>((resolve) => {
      harness.child.once("exit", () => resolve());
      harness.child.kill("SIGTERM");
      const force = setTimeout(() => {
        harness.child.kill("SIGKILL");
      }, 2000);
      force.unref?.();
      harness.child.once("exit", () => clearTimeout(force));
    });
  }
  fs.rmSync(harness.dir, { recursive: true, force: true });
}

describe("INF-1262 AC6/AC7: production bootstrap registers controller + scheduler, liveness observable without triggers", () => {
  // AC6 and AC7 both assert on /health.dispatchReliability from the SAME
  // production boot — one entry-point child process serves both, fetched
  // once in beforeAll, rather than two. Booting dist/index.js is genuinely
  // heavy (cron registration, DB init, workflow registry load); under the
  // full suite, ~20 other files boot this same entry point concurrently
  // across jest workers, and this file previously doubled that footprint
  // for no assertion this couldn't already share (review finding: cross-
  // test-file contention from this file's resource use).
  let harness: EntryPointHarness | undefined;
  let body: Record<string, any>;

  beforeAll(async () => {
    harness = await startEntryPoint("inf-1262-ac6-ac7-bootstrap-");
    try {
      body = await pollHealth(`http://127.0.0.1:${harness.port}/health`, 30_000);
    } catch (err) {
      throw new Error(
        `entry point never responded on /health: ${err instanceof Error ? err.message : String(err)}\n` +
        `child stderr:\n${harness.stderr()}`,
      );
    }
  }, 60_000);

  afterAll(async () => {
    await stopEntryPoint(harness);
  });

  test("AC6: /health proves dispatchReliability registration", () => {
    expect(body.dispatchReliability).toBeDefined();
    expect(body.dispatchReliability).toEqual(
      expect.objectContaining({
        controllerRegistered: true,
        schedulerRegistered: true,
        controllerActive: true,
        schedulerActive: true,
      }),
    );
  });

  test("AC7: /health exposes scheduled/subscribed liveness before any breaker or stuck-delegate condition fires", () => {
    expect(body.dispatchReliability).toEqual(
      expect.objectContaining({
        controllerActive: true,
        controllerScheduled: true,
        schedulerActive: true,
        schedulerSubscribed: true,
        wakePolicyPrimitive: "dispatchWithAck",
        subscribedWakePaths: expect.arrayContaining([
          "governed-transition",
          "stuck-delegate-reprompt",
          "delegate-clear-recovery",
        ]),
      }),
    );
  });
});
