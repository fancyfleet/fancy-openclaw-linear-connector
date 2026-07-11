export interface WebhookRow {
    id: string;
    url: string;
    teamLabel: string;
    secretPreview: string;
    lastSeen: string | null;
}
export type AddResult = {
    ok: true;
    webhook: WebhookRow;
} | {
    ok: false;
    status: number;
    error: string;
};
/** Masked preview that exposes only a short suffix, never the full secret. */
export declare function maskSecret(secret: string): string;
/** AC1 — every runtime secret rendered as a row with masked preview + metadata. */
export declare function listWebhooks(): WebhookRow[];
/** AC2 + AC4 — validate, persist the secret, store metadata, echo the new row. */
export declare function addWebhook(input: {
    url?: unknown;
    secret?: unknown;
    teamLabel?: unknown;
}): AddResult;
/** AC3 — remove the secret from the env file + runtime and drop its metadata. */
export declare function removeWebhook(id: string): {
    ok: boolean;
    status: number;
};
//# sourceMappingURL=registry.d.ts.map