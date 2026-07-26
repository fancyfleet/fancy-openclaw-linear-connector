import type { DispatchRecordStore } from "./liveness-channel/dispatch-record-store.js";
import type { GatewayDispatchStatus } from "./liveness-channel/gateway-ack-types.js";

type VerifiedAckStatus = GatewayDispatchStatus;

export type PostFanoutChildVerificationStatus =
  | "verified"
  | "missing-child-result"
  | "missing-delegate"
  | "no-dispatch-record"
  | "pending"
  | "unaccepted-ack";

export interface FanoutChildForVerification {
  identifier: string;
  delegateAgentId: string | null;
}

export interface VerifyPostFanoutChildDispatchesInput {
  parentIdentifier: string;
  createdChildIdentifiers: string[];
  openChildren: FanoutChildForVerification[];
  dispatchStore: DispatchRecordStore;
}

export interface PostFanoutChildVerificationResult {
  identifier: string;
  delegateAgentId: string | null;
  verified: boolean;
  status: PostFanoutChildVerificationStatus;
  dispatchId: string | null;
  sessionKey: string | null;
  ackStatus: VerifiedAckStatus | "pending" | string | null;
}

export interface PostFanoutChildVerificationBatchResult {
  allVerified: boolean;
  expectedCount: number;
  resultCount: number;
  missingResultIdentifiers: string[];
  notVerifiedIdentifiers: string[];
  results: PostFanoutChildVerificationResult[];
}

export interface VerifyStewardFanoutDelegatesInput {
  parentIdentifier: string;
  expectedChildIdentifiers: string[];
  openChildren: FanoutChildForVerification[];
  dispatchStore: DispatchRecordStore;
}

export interface StewardFanoutDelegateVerificationResult {
  allDelegatesVerified: boolean;
  refused: boolean;
  summary: string;
  orphanIdentifiers: string[];
  notVerifiedIdentifiers: string[];
  results: PostFanoutChildVerificationResult[];
}

const VERIFIED_ACK_STATUSES = new Set<VerifiedAckStatus>(["accepted", "queued"]);

export function verifyPostFanoutChildDispatches(
  input: VerifyPostFanoutChildDispatchesInput,
): PostFanoutChildVerificationBatchResult {
  const openChildrenByIdentifier = new Map(input.openChildren.map((child) => [child.identifier, child]));
  const results: PostFanoutChildVerificationResult[] = input.createdChildIdentifiers.map((identifier) => {
    const child = openChildrenByIdentifier.get(identifier);
    if (!child) {
      return emptyResult(identifier, "missing-child-result");
    }

    if (!child.delegateAgentId) {
      return emptyResult(identifier, "missing-delegate");
    }

    const dispatch = input.dispatchStore.getDispatch(identifier);
    if (!dispatch) {
      return {
        ...emptyResult(identifier, "no-dispatch-record"),
        delegateAgentId: child.delegateAgentId,
      };
    }

    const ackStatus = dispatch.ack?.status ?? null;
    if (!ackStatus) {
      return {
        identifier,
        delegateAgentId: child.delegateAgentId,
        verified: false,
        status: "pending",
        dispatchId: dispatch.dispatchId,
        sessionKey: dispatch.sessionKey,
        ackStatus: "pending",
      };
    }

    const verified = VERIFIED_ACK_STATUSES.has(ackStatus);
    return {
      identifier,
      delegateAgentId: child.delegateAgentId,
      verified,
      status: verified ? "verified" : "unaccepted-ack",
      dispatchId: dispatch.dispatchId,
      sessionKey: dispatch.sessionKey,
      ackStatus,
    };
  });

  const missingResultIdentifiers = results
    .filter((result) => result.status === "missing-child-result")
    .map((result) => result.identifier);
  const notVerifiedIdentifiers = results
    .filter((result) => !result.verified)
    .map((result) => result.identifier);

  return {
    allVerified: notVerifiedIdentifiers.length === 0,
    expectedCount: input.createdChildIdentifiers.length,
    resultCount: results.length,
    missingResultIdentifiers,
    notVerifiedIdentifiers,
    results,
  };
}

export function verifyStewardFanoutDelegates(
  input: VerifyStewardFanoutDelegatesInput,
): StewardFanoutDelegateVerificationResult {
  const verification = verifyPostFanoutChildDispatches({
    parentIdentifier: input.parentIdentifier,
    createdChildIdentifiers: input.expectedChildIdentifiers,
    openChildren: input.openChildren,
    dispatchStore: input.dispatchStore,
  });
  const orphanIdentifiers = verification.results
    .filter((result) => result.status === "missing-delegate" || result.status === "missing-child-result")
    .map((result) => result.identifier);
  const allDelegatesVerified = verification.allVerified;

  return {
    allDelegatesVerified,
    refused: !allDelegatesVerified,
    summary: allDelegatesVerified
      ? `all-verified: ${input.parentIdentifier}`
      : `not-all-verified: ${input.parentIdentifier}; ${verification.notVerifiedIdentifiers.join(", ")}`,
    orphanIdentifiers,
    notVerifiedIdentifiers: verification.notVerifiedIdentifiers,
    results: verification.results,
  };
}

function emptyResult(
  identifier: string,
  status: Exclude<PostFanoutChildVerificationStatus, "verified" | "pending" | "unaccepted-ack">,
): PostFanoutChildVerificationResult {
  return {
    identifier,
    delegateAgentId: null,
    verified: false,
    status,
    dispatchId: null,
    sessionKey: null,
    ackStatus: null,
  };
}
