/**
 * AI-2069 — C3 generation store ↔ C4 apply store unification, end to end.
 *
 * Proves the seam this ticket closes: a proposal produced by the C3 deterministic
 * engine (`generateProposals`) is persisted through the explicit adapter
 * (`persistGeneratedProposals`) into the ONE store the running app wires
 * (`createApp(...).proposalStore`, C4), and from there it is:
 *
 *   1. readable by `getByIdempotencyKey` (apply-pipeline lookup), and
 *   2. visible in `GET /admin/api/proposals` (C5 console queue), and
 *   3. applyable via `POST /admin/api/proposals/:id/retry-apply`, yielding
 *      exactly one workflow-def version bump + one git commit.
 *
 * There is NO DI-injected fake store: the proposal is written into, and read
 * back out of, the real `ProposalStore` instance the admin routes hold — the
 * actual seam, driven through the actual HTTP surface. Generation, persistence,
 * console read, and apply are four independently-authored modules meeting for
 * the first time here.
 */
import request from "supertest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp } from "../index.js";
import { reloadAgents } from "../agents.js";
import {
  generateProposals,
  type FailureCluster,
  type GenerationContext,
} from "./proposal-generator.js";
import { persistGeneratedProposals } from "./generated-proposal-adapter.js";

const ADMIN_SECRET = "ai2069-admin-secret";

/** A minimal workflow def carrying the `version:` field the apply bumps. */
function defYaml(version: number): string {
  return `id: dev-impl
version: ${version}
archetype: single-task
entry_state: write-tests
states:
  - id: write-tests
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: done
  - id: done
    kind: terminal
    native_state: done
`;
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root });
}

function readDefVersion(root: string): number {
  const yaml = fs.readFileSync(path.join(root, "workflows", "dev-impl.yaml"), "utf8");
  const m = yaml.match(/^\s*version:\s*(\d+)/m);
  if (!m) throw new Error("def has no version line");
  return Number(m[1]);
}

describe("AI-2069 — generated proposal flows C3 engine → unified store → console → apply", () => {
  let dir: string;
  let configRoot: string;
  const guidanceRel = path.join("workflows", "dev-impl", "write-tests.md");
  let appState: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2069-e2e-"));

    // Admin console static assets + empty agents roster.
    const webDist = path.join(dir, "web-dist");
    fs.mkdirSync(webDist, { recursive: true });
    fs.writeFileSync(path.join(webDist, "index.html"), '<!doctype html><div id="root"></div>', "utf8");
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [] }), "utf8");

    // A git-tracked instance-config dir the apply pipeline commits into.
    configRoot = path.join(dir, "config");
    fs.mkdirSync(path.join(configRoot, "workflows", "dev-impl"), { recursive: true });
    fs.writeFileSync(path.join(configRoot, "workflows", "dev-impl.yaml"), defYaml(1), "utf8");
    fs.writeFileSync(
      path.join(configRoot, guidanceRel),
      "# write-tests\n\nWrite failing tests covering every in-scope AC before implementation.\n",
      "utf8",
    );
    git(configRoot, ["init", "-q"]);
    git(configRoot, ["config", "user.email", "igor@fancymatt.local"]);
    git(configRoot, ["config", "user.name", "igor"]);
    git(configRoot, ["add", "-A"]);
    git(configRoot, ["commit", "-q", "-m", "seed"]);

    process.env.AGENTS_FILE = agentsFile;
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.ADMIN_WEB_DIST = webDist;
    process.env.LINEAR_CONNECTOR_CONFIG_DIR = configRoot;
    reloadAgents();

    appState = createApp({
      proposalsDbPath: path.join(dir, "proposals.db"),
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "opevents.db"),
      observationsDbPath: path.join(dir, "obs.db"),
    });
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.ADMIN_SECRET;
    delete process.env.ADMIN_WEB_DIST;
    delete process.env.LINEAR_CONNECTOR_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("generate → console queue → retry-apply → one version bump + one git commit", async () => {
    // ── Generate (C3 engine, real) ──────────────────────────────────────────
    // readSurfaces returns the ACTUAL on-disk guidance bytes, so the target's
    // oldContent.hash matches what the apply pipeline's TOCTOU guard re-hashes.
    const ctx: GenerationContext = {
      readSurfaces: (workflowId, stateId) => {
        if (workflowId !== "dev-impl" || stateId !== "write-tests") return [];
        return [
          {
            kind: "guidance",
            path: guidanceRel,
            content: fs.readFileSync(path.join(configRoot, guidanceRel), "utf8"),
          },
        ];
      },
    };
    const clusters: FailureCluster[] = [
      {
        workflow: "dev-impl",
        step: "write-tests",
        reasonCode: "missing-ac-coverage",
        count: 5,
        exceedsThreshold: true,
        ticketIds: ["AI-1000", "AI-1001"],
      },
    ];

    const generated = generateProposals(clusters, ctx);
    expect(generated).toHaveLength(1);
    const key = generated[0].idempotencyKey;

    // ── Persist through the explicit adapter into the REAL wired store ───────
    const [adapted] = persistGeneratedProposals(appState.proposalStore, generated);
    expect(adapted.id).toBe(key);

    // AC1a: the generated proposal is readable by idempotency key (apply lookup).
    const byKey = appState.proposalStore.getByIdempotencyKey(key);
    expect(byKey).not.toBeNull();
    expect(byKey?.idempotencyKey).toBe(key);

    // AC1b: and it appears in the C5 console queue.
    const listRes = await request(appState.app)
      .get("/admin/api/proposals")
      .set("x-admin-secret", ADMIN_SECRET);
    expect(listRes.status).toBe(200);
    const ids = (listRes.body.proposals as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(key);

    // ── Apply via the console's retry route ─────────────────────────────────
    const versionBefore = readDefVersion(configRoot);
    const commitsBefore = execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: configRoot,
    })
      .toString()
      .trim();

    const applyRes = await request(appState.app)
      .post(`/admin/api/proposals/${encodeURIComponent(key)}/retry-apply`)
      .set("x-admin-secret", ADMIN_SECRET)
      .send({});

    // AC2: applied, exactly one version bump, exactly one new commit.
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.ok).toBe(true);
    expect(applyRes.body.status).toBe("applied");

    expect(readDefVersion(configRoot)).toBe(versionBefore + 1);

    const commitsAfter = execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: configRoot,
    })
      .toString()
      .trim();
    expect(Number(commitsAfter)).toBe(Number(commitsBefore) + 1);

    const lastCommit = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: configRoot })
      .toString()
      .trim();
    expect(lastCommit).toContain(`apply: proposal ${key}`);

    // The guidance surface actually changed on disk (the semantic edit landed).
    const appliedGuidance = fs.readFileSync(path.join(configRoot, guidanceRel), "utf8");
    expect(appliedGuidance).toBe(generated[0].targets[0].newContent);

    // AC1/idempotency: the store now reflects the applied outcome on the SAME row.
    const afterApply = appState.proposalStore.getById(key);
    expect(afterApply?.status).toBe("applied");
    expect(afterApply?.version).toBe(versionBefore + 1);
  });
});
