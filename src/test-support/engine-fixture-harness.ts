type TierName = "engine" | "config-regression";
type TierStatus = "passed" | "failed" | "skipped";

export interface EngineFixtureHarnessOptions {
  skipTiers?: string[];
  forceFailures?: Partial<Record<TierName, string>>;
}

export interface EngineFixtureHarnessTierResult {
  tested: boolean;
  status: TierStatus;
  report: string;
}

export interface EngineFixtureHarnessResult {
  tiers: Record<TierName, EngineFixtureHarnessTierResult>;
}

function runTier(
  tier: TierName,
  skipped: boolean,
  forcedFailure?: string,
): EngineFixtureHarnessTierResult {
  if (skipped) {
    return {
      tested: false,
      status: "skipped",
      report: `${tier} skipped`,
    };
  }

  if (forcedFailure) {
    return {
      tested: true,
      status: "failed",
      report: `${tier} tested: ${forcedFailure}`,
    };
  }

  return {
    tested: true,
    status: "passed",
    report: `${tier} tested`,
  };
}

export async function runEngineFixtureHarness(
  options: EngineFixtureHarnessOptions = {},
): Promise<EngineFixtureHarnessResult> {
  const skipped = new Set(options.skipTiers ?? []);

  return {
    tiers: {
      engine: runTier("engine", skipped.has("engine"), options.forceFailures?.engine),
      "config-regression": runTier(
        "config-regression",
        skipped.has("config-regression"),
        options.forceFailures?.["config-regression"],
      ),
    },
  };
}
