import { initAlertBus, _resetAlertBusForTests, getAlertBus } from "../alerts/alert-bus.js";
import { extractRejectedWebhookDiagnostic, correlateRegistration, WebhookSecretDriftTracker } from "./drift.js";
import type { RegisteredWebhookDescriptor } from "./registry.js";

describe("webhook secret drift diagnostics", () => {
  afterEach(() => {
    _resetAlertBusForTests();
  });

  test("extracts webhook and team identity from a rejected Linear body", () => {
    const body = Buffer.from(JSON.stringify({
      webhookId: "wh_123",
      organizationId: "org_123",
      type: "Issue",
      action: "update",
      data: {
        team: { id: "team_1", key: "ENG" },
      },
    }));

    expect(extractRejectedWebhookDiagnostic(body)).toEqual({
      webhookId: "wh_123",
      organizationId: "org_123",
      teamKey: "ENG",
      type: "Issue",
      action: "update",
      parseStatus: "parsed",
    });
  });

  test("malformed bodies are diagnostic failures, not thrown exceptions", () => {
    expect(extractRejectedWebhookDiagnostic(Buffer.from("not-json{{"))).toEqual({
      webhookId: null,
      organizationId: null,
      teamKey: null,
      type: null,
      action: null,
      parseStatus: "malformed",
    });
  });

  test("alerts once a team/webhook crosses the drift threshold", () => {
    initAlertBus({ pushEnabled: false });
    const tracker = new WebhookSecretDriftTracker({ threshold: 2, windowMs: 60_000 });
    const diagnostic = {
      webhookId: "wh_drift",
      organizationId: "org_1",
      teamKey: "LSO",
      type: "Issue",
      action: "create",
      parseStatus: "parsed" as const,
    };

    tracker.record({ diagnostic, secretCount: 20, occurredAt: new Date("2026-07-25T12:00:00Z") });
    expect(getAlertBus().getStore()!.query({ source: "webhook-secret-drift" })).toHaveLength(0);

    tracker.record({ diagnostic, secretCount: 20, occurredAt: new Date("2026-07-25T12:00:10Z") });

    const alerts = getAlertBus().getStore()!.query({ source: "webhook-secret-drift" });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain("team LSO / webhook wh_drift");
    expect(alerts[0].detail).toMatchObject({
      teamKey: "LSO",
      webhookId: "wh_drift",
      rejectCount: 2,
      loadedHmacCount: 20,
    });
  });
});

describe("INF-667 — reject diagnostics resolve to actionable registry metadata", () => {
  afterEach(() => {
    _resetAlertBusForTests();
  });

  const registered: RegisteredWebhookDescriptor[] = [
    { id: "wh_020ff874eee0dc6b", teamLabel: "Loafsoft Operations", url: "https://ai.fcy.sh/?team=LSO", teamKey: "LSO", secretPreview: "lin_wh_…xyz", lastSeen: null },
    { id: "wh_e955bf58016e23cd", teamLabel: "Design", url: "https://ai.fcy.sh/?team=DSN", teamKey: "DSN", secretPreview: "lin_wh_…abc", lastSeen: "2026-07-25T14:14:00.000Z" },
  ];

  const diagnostic = {
    webhookId: "9aaf41cd-d2ab-4ef1-b45d-11226ec834d8",
    organizationId: "org_1",
    teamKey: "LSO",
    type: "Comment",
    action: "create",
    parseStatus: "parsed" as const,
  };

  test("correlateRegistration maps a rejected teamKey to its single registration", () => {
    expect(correlateRegistration(diagnostic, registered)).toEqual(registered[0]);
  });

  test("correlateRegistration returns null when the team is ambiguous or unknown", () => {
    expect(correlateRegistration({ ...diagnostic, teamKey: "BBS" }, registered)).toBeNull();
    const dup = [...registered, { ...registered[0], id: "wh_dup" }];
    expect(correlateRegistration(diagnostic, dup)).toBeNull();
    expect(correlateRegistration(diagnostic, undefined)).toBeNull();
  });

  test("the drift alert names the actionable registration, not the Linear UUID", () => {
    initAlertBus({ pushEnabled: false });
    const tracker = new WebhookSecretDriftTracker({ threshold: 1, windowMs: 60_000 });

    tracker.record({ diagnostic, secretCount: 20, registered, occurredAt: new Date("2026-07-25T12:00:00Z") });

    const alert = getAlertBus().getStore()!.query({ source: "webhook-secret-drift" })[0];
    const detail = alert.detail as Record<string, unknown>;
    // The suspect's actionable identifiers survive; the masked preview is
    // redacted by the alert bus (any `secret*` key) — defense in depth.
    expect(detail.suspectRegistration).toMatchObject({
      id: "wh_020ff874eee0dc6b",
      teamLabel: "Loafsoft Operations",
      url: "https://ai.fcy.sh/?team=LSO",
      teamKey: "LSO",
    });
    expect(Array.isArray(detail.registeredWebhooks)).toBe(true);
    expect((detail.registeredWebhooks as unknown[]).length).toBe(2);
    // The remediation must point the operator at the human-facing registration
    // (the `wh_` id + teamLabel + url) — the opaque Linear UUID may still appear
    // as origin context, but it is no longer the *only* identifier offered.
    expect(detail.message).toContain("wh_020ff874eee0dc6b");
    expect(detail.message).toContain("Loafsoft Operations");
    expect(detail.message).toContain("https://ai.fcy.sh/?team=LSO");
  });

  test("with no correlated suspect the alert still surfaces the registry table", () => {
    initAlertBus({ pushEnabled: false });
    const tracker = new WebhookSecretDriftTracker({ threshold: 1, windowMs: 60_000 });

    tracker.record({ diagnostic: { ...diagnostic, teamKey: "BBS" }, secretCount: 20, registered, occurredAt: new Date("2026-07-25T12:00:00Z") });

    const alert = getAlertBus().getStore()!.query({ source: "webhook-secret-drift" })[0];
    const detail = alert.detail as Record<string, unknown>;
    expect(detail.suspectRegistration).toBeNull();
    expect(Array.isArray(detail.registeredWebhooks)).toBe(true);
    expect((detail.registeredWebhooks as unknown[]).length).toBe(2);
    expect(detail.message).toContain("registeredWebhooks below");
  });
});
