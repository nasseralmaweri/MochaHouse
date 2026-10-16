"use client";

import { useActionState, useEffect, useRef } from "react";
import type { PlatformReconciliationRunResponse } from "@mocha-house/contracts";
import {
  resolveCaseAction,
  runReconciliationAction,
  type BillingActionState,
} from "@/lib/platform/billing-actions";
import { PRIMARY, Refusal, SECONDARY } from "./SubscriptionPanel";

const RUN_INITIAL: BillingActionState<PlatformReconciliationRunResponse> = { outcome: null };
const RESOLVE_INITIAL: BillingActionState<{ resolved: true }> = { outcome: null };

// SC3b — run the review-only reconciliation. It compares our records with the
// billing provider and opens cases; it never moves money or changes a
// subscription.
export function RunReconciliation() {
  const [state, formAction, pending] = useActionState(runReconciliationAction, RUN_INITIAL);
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.outcome) result.current?.focus();
  }, [state]);
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col items-start gap-3"
    >
      <button type="submit" aria-disabled={pending} aria-busy={pending} className={PRIMARY}>
        {pending ? "Checking…" : "Run reconciliation"}
      </button>
      <div ref={result} tabIndex={-1} className="focus:outline-none">
        {state.outcome?.kind === "ok" ? (
          <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
            Checked {state.outcome.data.subscriptionsChecked} billed business
            {state.outcome.data.subscriptionsChecked === 1 ? "" : "es"}:{" "}
            {state.outcome.data.casesOpened} new case
            {state.outcome.data.casesOpened === 1 ? "" : "s"} to review,{" "}
            {state.outcome.data.checkoutsExpired} expired payment page
            {state.outcome.data.checkoutsExpired === 1 ? "" : "s"} closed. Nothing was charged
            or changed.
          </p>
        ) : (
          <Refusal outcome={state.outcome} standalone />
        )}
      </div>
    </form>
  );
}

export function ResolveCase({ caseId }: { caseId: string }) {
  const [state, formAction, pending] = useActionState(resolveCaseAction, RESOLVE_INITIAL);
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col items-start gap-2"
    >
      <input type="hidden" name="caseId" value={caseId} />
      <button type="submit" aria-disabled={pending} aria-busy={pending} className={SECONDARY}>
        {pending ? "Saving…" : "Mark reviewed"}
      </button>
      <Refusal outcome={state.outcome} standalone />
    </form>
  );
}
