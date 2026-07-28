/**
 * AI-1954 — OpsActions: redispatch / set-state / recapture-ac / deploy buttons
 * for the management console ticket-detail and fleet views.
 *
 * AC4: buttons with confirmation dialogs; unauthorized session surfaces error.
 * AC5: deploy button present; disabled-with-reason (deploy-policy ci_auto_deploy:false).
 */
import { useState } from "react";
import { apiGet, apiPost, UnauthorizedError } from "../api";

export interface OpsActionsProps {
  ticketId: string;
  /** Console session username used as the invoker identity for audit attribution. */
  invoker: string;
  /**
   * "full" (default) renders redispatch + set-state + recapture-ac + deploy —
   * used on the ticket-detail view. "redispatch" renders only the Redispatch
   * action, for per-row use on the fleet page (ticket scope: fleet = redispatch).
   */
  variant?: "full" | "redispatch";
}

type GovernedTier = "T0" | "T1" | "T2";
type GovernedAction = "delegate-set" | "force-redispatch" | "promote" | "park" | "probe";
type DialogKind = GovernedAction | "set-state" | "recapture-ac" | null;

const GOVERNED_ACTIONS: Record<GovernedAction, { label: string; tier: GovernedTier; capability: `governed-console:${GovernedAction}` }> = {
  "delegate-set": { label: "Delegate Set", tier: "T1", capability: "governed-console:delegate-set" },
  "force-redispatch": { label: "Force Dispatch", tier: "T1", capability: "governed-console:force-redispatch" },
  promote: { label: "Promote", tier: "T1", capability: "governed-console:promote" },
  park: { label: "Park", tier: "T2", capability: "governed-console:park" },
  probe: { label: "Probe", tier: "T0", capability: "governed-console:probe" },
};

function GovernedControl({ action, onClick }: { action: GovernedAction; onClick: () => void }) {
  const meta = GOVERNED_ACTIONS[action];
  return (
    <button type="button" data-tier={meta.tier} data-capability={meta.capability} onClick={onClick}>
      {meta.label}
    </button>
  );
}

function AuditReceipt({ receipt }: { receipt: { action?: string; mutationCount?: number } | null }) {
  if (!receipt) return null;
  return <p data-kind="audit-receipt">AuditReceipt {receipt.action} {receipt.mutationCount}</p>;
}

function ProbePanel({ result }: { result: unknown }) {
  if (!result) return null;
  return <pre data-kind="probe-panel">ProbePanel {JSON.stringify(result, null, 2)}</pre>;
}

export function OpsActions({ ticketId, invoker, variant = "full" }: OpsActionsProps) {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [targetState, setTargetState] = useState("");
  const [delegate, setDelegate] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [auditReceipt, setAuditReceipt] = useState<{ action?: string; mutationCount?: number } | null>(null);
  const [probeResult, setProbeResult] = useState<unknown>(null);

  function openDialog(kind: DialogKind) {
    setDialog(kind);
    setTargetState("");
    setDelegate("");
    setReason("");
    setError(null);
  }

  function closeDialog() {
    setDialog(null);
    setTargetState("");
    setReason("");
    setError(null);
  }

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    try {
      const governed = dialog && dialog in GOVERNED_ACTIONS ? GOVERNED_ACTIONS[dialog as GovernedAction] : null;
      if (dialog === "redispatch") {
        await apiPost("/admin/api/redispatch", { ticketId });
      } else if (dialog === "force-redispatch" && governed) {
        const res = await apiPost<{ auditReceipt?: { action?: string; mutationCount?: number } }>("/admin/api/redispatch", {
          ticketId, invoker, reason, role: "steward", capability: governed.capability,
        });
        setAuditReceipt(res.auditReceipt ?? null);
      } else if (dialog === "delegate-set" && governed) {
        const res = await apiPost<{ auditReceipt?: { action?: string; mutationCount?: number } }>("/admin/api/set-state", {
          action: "delegate-set", ticketId, delegateMode: delegate ? "set" : "leave", delegate, invoker, reason, role: "steward", capability: governed.capability,
        });
        setAuditReceipt(res.auditReceipt ?? null);
      } else if ((dialog === "promote" || dialog === "park") && governed) {
        const res = await apiPost<{ auditReceipt?: { action?: string; mutationCount?: number } }>(`/admin/api/backlog/${dialog}`, {
          ticketId, invoker, reason, role: "steward", capability: governed.capability,
        });
        setAuditReceipt(res.auditReceipt ?? null);
      } else if (dialog === "probe" && governed) {
        setProbeResult(await apiGet(`/admin/api/probe/${ticketId}?invoker=${encodeURIComponent(invoker)}&role=steward&capability=${encodeURIComponent(governed.capability)}`));
      } else if (dialog === "set-state") {
        await apiPost("/admin/api/set-state", { ticketId, invoker, reason, targetState });
      } else if (dialog === "recapture-ac") {
        await apiPost("/admin/api/recapture-ac", { ticketId, callerBodyId: invoker, invoker, reason });
      }
      closeDialog();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setError("Unauthorized: your session does not have permission to perform this action.");
      } else {
        setError(err instanceof Error ? err.message : "An unexpected error occurred.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ops-actions">
      <button type="button" onClick={() => openDialog("redispatch")}>Redispatch</button>
      {variant === "full" && (
        <>
          <GovernedControl action="delegate-set" onClick={() => openDialog("delegate-set")} />
          <GovernedControl action="force-redispatch" onClick={() => openDialog("force-redispatch")} />
          <GovernedControl action="promote" onClick={() => openDialog("promote")} />
          <GovernedControl action="park" onClick={() => openDialog("park")} />
          <GovernedControl action="probe" onClick={() => openDialog("probe")} />
          <button type="button" onClick={() => openDialog("set-state")}>Set State</button>
          <button
            type="button"
            onClick={() => openDialog("recapture-ac")}
          >
            Recapture AC
          </button>
          {/* AC5: deploy disabled — deploy-policy.yaml sets ci_auto_deploy:false for this repo */}
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Deploy is disabled: deploy-policy.yaml sets ci_auto_deploy:false for fancy-openclaw-linear-connector. Use the handoff-host deploy path."
          >
            Deploy
          </button>
        </>
      )}

      {dialog !== null && (
        <div role="dialog" aria-modal="true" aria-label={`Confirm ${dialog}`}>
          <p>Confirm: <strong>{dialog}</strong> on <code>{ticketId}</code></p>

          {(dialog === "set-state") && (
            <div>
              <label htmlFor="ops-target-state">Target State</label>
              <input
                id="ops-target-state"
                type="text"
                placeholder="state"
                value={targetState}
                onChange={(e) => setTargetState(e.target.value)}
              />
            </div>
          )}

          {dialog === "delegate-set" && (
            <div>
              <label htmlFor="ops-delegate">Delegate</label>
              <input
                id="ops-delegate"
                type="text"
                value={delegate}
                onChange={(e) => setDelegate(e.target.value)}
              />
            </div>
          )}

          {(dialog === "set-state" || dialog === "recapture-ac" || dialog === "delegate-set" || dialog === "force-redispatch" || dialog === "promote" || dialog === "park") && (
            <div>
              <label htmlFor="ops-reason">Reason</label>
              <input
                id="ops-reason"
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          )}

          {error && <p role="alert">{error}</p>}

          <button type="button" onClick={handleConfirm} disabled={loading}>
            Confirm
          </button>
          <button type="button" onClick={closeDialog} disabled={loading}>
            Cancel
          </button>
        </div>
      )}
      <AuditReceipt receipt={auditReceipt} />
      <ProbePanel result={probeResult} />
    </div>
  );
}
