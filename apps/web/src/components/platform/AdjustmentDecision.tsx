"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import type { PlatformAdjustmentView } from "@mocha-house/contracts";
import { decideAdjustmentAction, type BillingActionState } from "@/lib/platform/billing-actions";
import { ADJUSTMENT_STATUS_LABELS, FUTURE_CHARGES, NO_ACCESS_EFFECTS, money } from "@/lib/platform/adjustments";
import { PRIMARY, Refusal, SECONDARY } from "./SubscriptionPanel";

const TEXTAREA =
  "min-h-20 w-full rounded-lg border border-border-default bg-surface-card px-3 py-2 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const INITIAL: BillingActionState<PlatformAdjustmentView> = { outcome: null };

// SC3e-3 — the decision on a refund or credit request: approve or reject (an
// approver who isn't the requester), withdraw (the requester), or resolve a
// reviewed one as not issued. A note is always required; the API re-checks
// who may and re-reads the payment provider before anything is issued.
export function AdjustmentDecision({
  view,
  mode,
}: {
  view: PlatformAdjustmentView;
  mode: "decide" | "cancel" | "resolve";
}) {
  const [state, formAction, pending] = useActionState(decideAdjustmentAction, INITIAL);
  const id = useId();
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.outcome) result.current?.focus();
  }, [state]);
  const amount = money(view.totalMinorUnits, view.currency);
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col gap-3 rounded-2xl border border-border-default bg-surface-card p-5"
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`} className="text-base font-semibold text-text-primary">
        {mode === "decide" ? "Your decision" : mode === "cancel" ? "Withdraw your request" : "Resolve after review"}
      </h2>
      <input type="hidden" name="adjustmentId" value={view.id} />
      {mode === "decide" ? (
        <>
          <p className="text-sm text-text-primary">
            Approving {view.kind === "REFUND" ? `refunds ${amount} to the business's original payment method` : `credits ${amount} toward the business's future invoices`}
            {view.requiredApprovals > 1 ? " once the second approver approves too" : " at once"}. The payment
            provider is checked again first; if its amount changed, nothing is issued.
          </p>
          <p className="rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-text-primary">{NO_ACCESS_EFFECTS}</p>
        </>
      ) : mode === "resolve" ? (
        <p className="text-sm text-text-primary">
          The payment provider is read again. If it holds this credit note after all, the adjustment is confirmed
          instead; otherwise it is closed as not issued. Nothing is sent to the provider.
        </p>
      ) : (
        <p className="text-sm text-text-primary">Withdrawing ends the request. Nothing is refunded or credited.</p>
      )}
      <label htmlFor={`${id}-note`} className="text-sm font-medium text-text-primary">
        Note (required)
      </label>
      <textarea id={`${id}-note`} name="note" required minLength={10} maxLength={500} className={TEXTAREA} />
      {mode === "decide" ? (
        <label className="flex min-h-11 items-start gap-2 text-sm text-text-primary">
          <input type="checkbox" name="understood" value="yes" className="mt-1" />
          To approve: I checked the amount and the reason, and I understand: {FUTURE_CHARGES}
        </label>
      ) : null}
      <div ref={result} tabIndex={-1} className="flex flex-col gap-2 focus:outline-none">
        {state.outcome?.kind === "ok" ? (
          <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
            Saved. Now: {ADJUSTMENT_STATUS_LABELS[state.outcome.data.status]}.
          </p>
        ) : null}
        <Refusal outcome={state.outcome} />
      </div>
      <div className="flex flex-wrap gap-3">
        {mode === "decide" ? (
          <>
            <button type="submit" name="step" value="approve" aria-disabled={pending} className={PRIMARY}>
              {pending ? "Saving…" : "Approve"}
            </button>
            <button type="submit" name="step" value="reject" aria-disabled={pending} className={SECONDARY}>
              Reject
            </button>
          </>
        ) : (
          <button
            type="submit"
            name="step"
            value={mode === "cancel" ? "cancel" : "resolve-not-issued"}
            aria-disabled={pending}
            className={SECONDARY}
          >
            {pending ? "Saving…" : mode === "cancel" ? "Withdraw request" : "Check and resolve"}
          </button>
        )}
      </div>
    </form>
  );
}
