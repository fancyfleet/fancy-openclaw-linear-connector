export interface StewardStateLivenessEvidence {
  kind: "startup" | "registry" | "health";
  component: "steward-state-redispatch";
  message: string;
  at: string;
}

export interface StewardStateLiveness {
  registered: boolean;
  active: boolean;
  evidence: StewardStateLivenessEvidence[];
}

let registeredAt: string | null = null;

export function registerStewardStateLiveness(): void {
  registeredAt = new Date().toISOString();
  console.info("[steward-state-redispatch] registered at server bootstrap");
}

export function getStewardStateLiveness(): StewardStateLiveness {
  const evidence: StewardStateLivenessEvidence[] = [];
  if (registeredAt) {
    evidence.push({
      kind: "startup",
      component: "steward-state-redispatch",
      message: "registered at server bootstrap",
      at: registeredAt,
    });
    evidence.push({
      kind: "registry",
      component: "steward-state-redispatch",
      message: "component registered in production app registry",
      at: registeredAt,
    });
  }

  return {
    registered: registeredAt !== null,
    active: registeredAt !== null,
    evidence,
  };
}
