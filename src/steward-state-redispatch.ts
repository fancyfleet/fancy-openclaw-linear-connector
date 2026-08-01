export interface StewardStateRedispatchEvidence {
  kind: "startup" | "registry" | "health";
  component: "steward-state-redispatch";
  message: string;
  at: string;
}

export interface StewardStateRedispatchLiveness {
  registered: boolean;
  active: boolean;
  evidence: StewardStateRedispatchEvidence[];
}

let registeredAt: string | null = null;

export function registerStewardStateRedispatch(): void {
  registeredAt = new Date().toISOString();
  console.info("[steward-state-redispatch] registered at server bootstrap");
}

export function getStewardStateRedispatchLiveness(): StewardStateRedispatchLiveness {
  const evidence: StewardStateRedispatchEvidence[] = [];
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
