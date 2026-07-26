import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";

/**
 * Resolve the canonical fixture path for a given workflow id.
 * Fixtures live in src/__fixtures__/canonical-{workflowId}.yaml.
 */
export function fixturePathFor(workflowId: string): string {
  const repoRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
  return path.join(repoRoot, "src", "__fixtures__", `canonical-${workflowId}.yaml`);
}

function parseYamlNormalized(content: string): unknown {
  return yaml.load(content);
}

export async function checkDefAgainstFixture(
  deployedId: string,
  deployedContent: string,
): Promise<{
  fixtureExists: boolean;
  inSync: boolean;
  driftDescription: string | null;
}> {
  const fixturePath = fixturePathFor(deployedId);

  let fixtureContent: string;
  try {
    fixtureContent = await fs.readFile(fixturePath, "utf8");
  } catch {
    return {
      fixtureExists: false,
      inSync: false,
      driftDescription: `Canonical fixture not found at ${fixturePath}`,
    };
  }

  const deployedParsed = parseYamlNormalized(deployedContent);
  const fixtureParsed = parseYamlNormalized(fixtureContent);

  const deployedStr = JSON.stringify(deployedParsed);
  const fixtureStr = JSON.stringify(fixtureParsed);

  if (deployedStr === fixtureStr) {
    return { fixtureExists: true, inSync: true, driftDescription: null };
  }

  const differences: string[] = [];
  if (deployedParsed && fixtureParsed && typeof deployedParsed === "object" && typeof fixtureParsed === "object") {
    const d = deployedParsed as Record<string, unknown>;
    const f = fixtureParsed as Record<string, unknown>;
    for (const key of new Set([...Object.keys(d), ...Object.keys(f)])) {
      if (JSON.stringify(d[key]) !== JSON.stringify(f[key])) {
        differences.push(`${key}: deployed=${JSON.stringify(d[key])} fixture=${JSON.stringify(f[key])}`);
      }
    }
  }

  return {
    fixtureExists: true,
    inSync: false,
    driftDescription: `Structural drift detected: ${differences.join("; ")}`,
  };
}
