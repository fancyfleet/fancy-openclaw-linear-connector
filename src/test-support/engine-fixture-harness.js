function runTier(tier, skipped, forcedFailure) {
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

export async function runEngineFixtureHarness(options = {}) {
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
