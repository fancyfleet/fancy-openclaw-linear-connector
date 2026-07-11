/**
 * AI-1547 — Transition atomicity + standing anti-entropy reconciliation loop (G-7/G-17).
 *
 * Two checks per pass:
 *   AC1 — Native state desync: state:* label implies a native Linear stateId that
 *          differs from what Linear actually has (crash between the two writes).
 *          Heal by issuing an issueUpdate with the correct stateId.
 *
 *   AC2 — Missed barrier webhook: a managing-state parent whose children are ALL
 *          terminal but whose barrier never fired (dropped webhook). Heal by
 *          advancing the parent to the next state.
 *
 *   AC3 — Standing cadence: registerAntiEntropyCron runs the pass periodically
 *          (not boot-time only). The result carries drift counts so callers can alert.
 */
export interface AntiEntropyOptions {
    authToken: string;
}
export interface AntiEntropyResult {
    scanned: number;
    nativeDesyncFound: number;
    nativeDesyncHealed: number;
    barrierMissedFound: number;
    barrierMissedReconciled: number;
    errors: string[];
}
export declare function runAntiEntropyPass(opts: AntiEntropyOptions): Promise<AntiEntropyResult>;
export declare function registerAntiEntropyCron(opts?: {
    intervalMs?: number;
    authToken?: string;
}): NodeJS.Timeout;
//# sourceMappingURL=anti-entropy.d.ts.map