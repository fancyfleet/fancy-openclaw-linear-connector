import { afterEach, describe, expect, it, jest } from "@jest/globals";

const aiAccessToken = jest.fn<() => string | undefined>(() => undefined);

jest.unstable_mockModule("./agents.js", () => ({
  getAccessToken: aiAccessToken,
}));

const dedicatedEnvKeys = [
  "LINEAR_SERVICE_CREDENTIAL",
  "LINEAR_SERVICE_CREDENTIAL_TOKEN",
  "LINEAR_RECONCILIATION_TOKEN",
];

describe("INF-1212 dedicated Linear service credential contract", () => {
  afterEach(() => {
    aiAccessToken.mockReset();
    aiAccessToken.mockReturnValue(undefined);
    for (const key of dedicatedEnvKeys) delete process.env[key];
    jest.resetModules();
  });

  it("resolves a dedicated credential when the ai agent OAuth token is unavailable", async () => {
    process.env.LINEAR_SERVICE_CREDENTIAL = "lin_service_dedicated_token";
    aiAccessToken.mockReturnValue(undefined);

    const { resolveServiceCredential } = await import("./service-credential.js");

    expect(resolveServiceCredential()).toBe("lin_service_dedicated_token");
    expect(aiAccessToken).not.toHaveBeenCalledWith("ai");
  });

  it("reports dedicated credential liveness separately from per-agent token liveness", async () => {
    process.env.LINEAR_SERVICE_CREDENTIAL = "lin_service_dedicated_token";
    aiAccessToken.mockReturnValue(undefined);

    const { getDedicatedCredentialLiveness } = await import("./service-credential.js");

    expect(getDedicatedCredentialLiveness()).toEqual(
      expect.objectContaining({
        active: true,
        valid: true,
        agent: null,
      }),
    );
  });
});
