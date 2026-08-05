/**
 * INF-1196 — Default enrollment / deprecation policy, config-driven.
 *
 * Two independent paths mint the `wf:*` label a ticket enrolls under —
 * `workflow-bootstrap.ts` (direct cross-functional-request enrollment) and
 * `fanout.ts` (spawner/fan-out children). INF-1164 froze `wf:task` in only
 * one of the two, hardcoding the replacement default as a source constant;
 * this module gives both paths one config source so a future default/
 * deprecation change is a config edit, never a code change + build + deploy
 * (life-os/project-management/engine-config-vs-code-principle.md).
 *
 * Policy file (instance config, NOT committed to this repo):
 *   {configRoot}/config/enrollment-policy.yaml   (override: ENROLLMENT_POLICY_PATH)
 *
 *   deprecated_workflow_ids:
 *     - task
 *   default_enrollment_workflow: chore
 *
 * Fail posture: a missing or malformed policy file falls back to the INF-1164
 * defaults (task deprecated, chore default) so the freeze holds even before an
 * instance provisions the file. The fallback is logged + alerted so silently
 * running on defaults never goes unnoticed.
 */

import fs from "node:fs";
import yaml from "js-yaml";
import { componentLogger, createLogger } from "./logger.js";
import { defaultEnrollmentPolicyPath } from "./instance-config.js";
import { notify } from "./alerts/alert-bus.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "enrollment-policy");

export interface EnrollmentPolicy {
  deprecatedWorkflowIds: string[];
  defaultEnrollmentWorkflow: string;
}

const FALLBACK_POLICY: EnrollmentPolicy = {
  deprecatedWorkflowIds: ["task"],
  defaultEnrollmentWorkflow: "chore",
};

export function enrollmentPolicyPath(): string {
  return process.env.ENROLLMENT_POLICY_PATH ?? defaultEnrollmentPolicyPath();
}

let cache: { policy: EnrollmentPolicy; path: string; mtimeMs: number } | null = null;

/** Test hook: drop the mtime-keyed cache. */
export function resetEnrollmentPolicyCache(): void {
  cache = null;
}

/**
 * Load the enrollment policy, cached by (path, mtime) so config edits are
 * picked up without a restart. Never throws.
 */
export function loadEnrollmentPolicy(pathOverride?: string): EnrollmentPolicy {
  const file = pathOverride ?? enrollmentPolicyPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // Missing file: fall back to the INF-1164 defaults so the freeze holds.
    cache = { policy: FALLBACK_POLICY, path: file, mtimeMs: -1 };
    return FALLBACK_POLICY;
  }

  if (cache && cache.path === file && cache.mtimeMs === mtimeMs) return cache.policy;

  try {
    const raw = yaml.load(fs.readFileSync(file, "utf8"));
    const data = raw as
      | { deprecated_workflow_ids?: unknown; default_enrollment_workflow?: unknown }
      | null;
    const deprecatedRaw = data?.deprecated_workflow_ids;
    const defaultRaw = data?.default_enrollment_workflow;
    if (
      raw === null ||
      typeof raw !== "object" ||
      !Array.isArray(deprecatedRaw) ||
      !deprecatedRaw.every((id) => typeof id === "string") ||
      typeof defaultRaw !== "string" ||
      defaultRaw.trim().length === 0
    ) {
      throw new Error(
        "enrollment-policy.yaml must be a mapping with 'deprecated_workflow_ids' (string array) and 'default_enrollment_workflow' (non-empty string)",
      );
    }
    const policy: EnrollmentPolicy = {
      deprecatedWorkflowIds: deprecatedRaw as string[],
      defaultEnrollmentWorkflow: defaultRaw.trim(),
    };
    cache = { policy, path: file, mtimeMs };
    return policy;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      `enrollment-policy: failed to load ${file}: ${msg} — falling back to INF-1164 defaults (deprecated=[task], default=chore)`,
    );
    notify({
      severity: "warning",
      source: "enrollment-policy",
      title: "enrollment-policy.yaml failed to load — using INF-1164 fallback defaults",
      detail: `${file}: ${msg}`,
    });
    cache = { policy: FALLBACK_POLICY, path: file, mtimeMs };
    return FALLBACK_POLICY;
  }
}
