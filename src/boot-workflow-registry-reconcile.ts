import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { componentLogger, createLogger } from "./logger.js";
import { resetWorkflowCache } from "./workflow-gate.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "boot-workflow-registry-reconcile");

export interface BootWorkflowRegistryReconcileResult {
  canonicalDir: string;
  targetDir: string;
  copied: string[];
  removed: string[];
}

function defaultCanonicalDefsDir(): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), "registered-defs");
}

async function assertReadableDirectory(dir: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch (err) {
    throw new Error(`${label} unreadable (${dir}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} unusable (${dir}): not a directory`);
  }
  try {
    await fs.access(dir, fs.constants.R_OK);
  } catch (err) {
    throw new Error(`${label} unreadable (${dir}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function assertWritableDirectory(dir: string, label: string): Promise<void> {
  try {
    await fs.access(dir, fs.constants.W_OK);
  } catch (err) {
    throw new Error(`${label} unwritable (${dir}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function workflowIdFromYaml(raw: string): string | null {
  const parsed = yaml.load(raw);
  if (parsed && typeof parsed === "object" && typeof (parsed as { id?: unknown }).id === "string") {
    return (parsed as { id: string }).id;
  }
  return null;
}

export async function reconcileBootWorkflowRegistry(): Promise<BootWorkflowRegistryReconcileResult | null> {
  const targetDir = process.env.WORKFLOW_DEFS_DIR || process.env.WORKFLOW_DEF_DIR || undefined;
  if (!targetDir) return null;

  const canonicalDir = process.env.WORKFLOW_CANONICAL_DEFS_DIR || defaultCanonicalDefsDir();
  await assertReadableDirectory(canonicalDir, "canonical workflow defs dir");
  await assertReadableDirectory(targetDir, "WORKFLOW_DEFS_DIR");
  await assertWritableDirectory(targetDir, "WORKFLOW_DEFS_DIR");

  const canonicalEntries = (await fs.readdir(canonicalDir)).filter((f) => f.endsWith(".yaml")).sort();
  if (canonicalEntries.length === 0) {
    throw new Error(`canonical workflow defs dir empty (${canonicalDir})`);
  }

  const canonicalIds = new Set<string>();
  const copied: string[] = [];
  for (const fileName of canonicalEntries) {
    const source = path.join(canonicalDir, fileName);
    const raw = await fs.readFile(source, "utf8");
    const id = workflowIdFromYaml(raw);
    if (!id) throw new Error(`canonical workflow def missing id (${source})`);
    canonicalIds.add(id);

    await fs.writeFile(path.join(targetDir, fileName), raw, "utf8");
    copied.push(fileName);
  }

  const removed: string[] = [];
  const targetEntries = (await fs.readdir(targetDir)).filter((f) => f.endsWith(".yaml")).sort();
  for (const fileName of targetEntries) {
    const target = path.join(targetDir, fileName);
    const raw = await fs.readFile(target, "utf8");
    const id = workflowIdFromYaml(raw);
    if (id && canonicalIds.has(id)) continue;

    await fs.unlink(target);
    removed.push(fileName);
  }

  resetWorkflowCache();
  log.info(
    `boot workflow registry reconcile complete: copied=${copied.length}, removed=${removed.length}, canonical=${canonicalDir}, target=${targetDir}`,
  );
  return { canonicalDir, targetDir, copied, removed };
}
