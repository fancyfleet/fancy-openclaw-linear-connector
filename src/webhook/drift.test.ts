import { initAlertBus, _resetAlertBusForTests, getAlertBus } from "../alerts/alert-bus.js";
import { extractRejectedWebhookDiagnostic, WebhookSecretDriftTracker } from "./drift.js";

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
