/**
 * INF-204 — dispatch messages must only advertise commands the CLI can execute.
 *
 * The sprint-spawner `evaluating` state carries `hold` and `start-cycle` moves
 * with no dedicated CLI verb. build-message rendered them verbatim
 * (`linear hold LIF-143`), the CLI died with "unknown command 'hold'", and the
 * governed leaf re-dispatched indefinitely with no discoverable exit.
 *
 * The CLI half shipped in fancy-openclaw-linear-skill-cli 0.4.4: a generic
 * `linear transition <id> <move>` verb that carries any move name through the
 * intent header. This suite pins the connector half: any transition whose
 * command is not a dedicated CLI verb renders in transition-form, so dispatch
 * and CLI stay structurally in sync — future workflow moves need no CLI
 * release and no build-message change.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetWorkflowCache } from "../workflow-gate.js";
import { resetPolicyCache } from "../escalation-gate.js";
import { _resetAppliedStateStore } from "../store/applied-state-store.js";

// Trimmed from the real sprint-spawner v4: the evaluating state exactly as
// deployed (proceed tagged generic, hold/start-cycle untagged), plus the
// minimum surrounding states to make the def loadable.
const TEST_WORKFLOW_YAML = `
id: sprint-spawner
version: 4
archetype: continuous-loop
entry_state: evaluating

break_glass:
  command: escape
  to: evaluating
  owner_role: steward

states:
  - id: evaluating
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: proceed
        to: scanning
        generic: continue
      - command: hold
        to: __terminal_hold__
      - command: start-cycle
        to: scanning

  - id: scanning
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: collect
        to: evaluating
        generic: continue

  - id: done
    kind: terminal
    native_state: done

  - id: __terminal_hold__
    kind: terminal
    native_state: invalid
`;

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: main-agent
    grants: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: ai
    openclaw_agent: main
    container: main-agent
    fills_roles: []
`;

function makeRoute(
  identifier: string,
  title: string,
): import("../types.js").RouteResult {
  return {
    agentId: "astrid",
    sessionKey: `linear-${identifier}`,
    priority: 0,
    routingReason: "delegate",
    event: {
      type: "Issue",
      action: "update",
      actor: { id: "u1", name: "Ai", type: "user" },
      data: { identifier, title },
    } as unknown as import("../types.js").RouteResult["event"],
  };
}

function makeLabelFetch(labels: string[]): typeof globalThis.fetch {
  return async (_url, _init) =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            labels: { nodes: labels.map((name) => ({ name })) },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

let tmpYamlPath: string;
let tmpGuidanceDir: string;
let tmpPolicyPath: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-message-inf204-"));
  tmpYamlPath = path.join(dir, "sprint-spawner.yaml");
  fs.writeFileSync(tmpYamlPath, TEST_WORKFLOW_YAML, "utf8");
  tmpGuidanceDir = path.join(dir, "guidance");
  fs.mkdirSync(path.join(tmpGuidanceDir, "sprint-spawner"), { recursive: true });
  tmpPolicyPath = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(tmpPolicyPath, TEST_POLICY_YAML, "utf8");
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  _resetAppliedStateStore();
  process.env.WORKFLOW_DEF_PATH = tmpYamlPath;
  process.env.WORKFLOW_GUIDANCE_DIR = tmpGuidanceDir;
  process.env.CAPABILITY_POLICY_PATH = tmpPolicyPath;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.WORKFLOW_GUIDANCE_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
  resetPolicyCache();
});

async function getbuildDeliveryMessage() {
  const mod = await import("./build-message.js");
  return mod.buildDeliveryMessage;
}

describe("INF-204 — non-dedicated workflow moves render as `linear transition <id> <move>`", () => {
  it("evaluating: hold and start-cycle render in transition-form; generic-tagged proceed is untouched", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-spawner", "state:evaluating"]);

    const buildDeliveryMessage = await getbuildDeliveryMessage();
    const msg = await buildDeliveryMessage(makeRoute("LIF-143", "Marketing loop"), "Bearer tok");

    expect(msg).toContain("[sprint-spawner]");
    expect(msg).toContain("state: **evaluating**");

    // The two moves the CLI cannot execute by name → generic transition verb.
    expect(msg).toContain("linear transition LIF-143 hold");
    expect(msg).toContain("linear transition LIF-143 start-cycle");

    // The exact broken forms the ticket reproduces must be gone.
    expect(msg).not.toContain("linear hold LIF-143");
    expect(msg).not.toContain("linear start-cycle LIF-143");

    // generic: continue still resolves to the dedicated continue-workflow verb.
    expect(msg).toContain("linear continue-workflow LIF-143");
    expect(msg).not.toContain("linear proceed LIF-143");
    expect(msg).not.toContain("linear transition LIF-143 proceed");
  });

  it("destination annotations survive the rewrite", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-spawner", "state:evaluating"]);

    const buildDeliveryMessage = await getbuildDeliveryMessage();
    const msg = await buildDeliveryMessage(makeRoute("LIF-143", "Marketing loop"), "Bearer tok");

    expect(msg).toContain("`linear transition LIF-143 hold` (→ __terminal_hold__)");
    expect(msg).toContain("`linear transition LIF-143 start-cycle` (→ scanning)");
  });
});
