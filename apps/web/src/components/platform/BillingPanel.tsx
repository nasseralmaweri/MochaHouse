"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type {
  BusinessBillingSummary,
  PlatformPlanPrice,
  PlatformTenantBillingResponse,
} from "@mocha-house/contracts";
import { BILLING_STATE_LABELS } from "@/lib/admin/billing";
import {
  startBillingAction,
  type BillingActionState,
} from "@/lib/platform/billing-actions";
import { PRIMARY, Refusal, SECONDARY, SELECT } from "./SubscriptionPanel";

const INITIAL: BillingActionState<PlatformTenantBillingResponse> = { outcome: null };

function money(amount: number, currency: string, interval: "MONTH" | "YEAR") {
  const value = new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);
  return `${value} per ${interval === "MONTH" ? "month" : "year"}`;
}

// SC3b — a business's billing in the Platform Console. A complimentary
// (non-Founding) business can be started on one ACTIVE price of its current
// plan, after a review step; the owner then sets up payment from the
// business admin. Nothing is charged here.
export function BillingPanel({
  tenantId,
  billing,
  isFounding,
  prices,
}: {
  tenantId: string;
  billing: BusinessBillingSummary | null;
  isFounding: boolean;
  prices: PlatformPlanPrice[];
}) {
  const [state, formAction, pending] = useActionState(startBillingAction, INITIAL);
  const [priceId, setPriceId] = useState(prices[0]?.id ?? "");
  const [reviewing, setReviewing] = useState(false);
  const id = useId();
  const confirmRegion = useRef<HTMLDivElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const result = useRef<HTMLDivElement>(null);
  const current = state.outcome?.kind === "ok" ? state.outcome.data.billing : billing;

  useEffect(() => {
    if (reviewing) confirmRegion.current?.focus();
    else if (returnFocus.current) reviewButton.current?.focus();
    returnFocus.current = false;
  }, [reviewing]);
  useEffect(() => {
    if (state.outcome) result.current?.focus();
  }, [state]);

  if (!current) {
    return <p className="text-sm text-text-secondary">This business has no subscription yet.</p>;
  }
  const selected = prices.find((price) => price.id === priceId) ?? null;
  const canStart = current.state === "COMPLIMENTARY" && !isFounding;

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border-default bg-surface-card p-5">
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-text-secondary">Billing</dt>
          <dd className="font-medium text-text-primary">{BILLING_STATE_LABELS[current.state]}</dd>
        </div>
        <div>
          <dt className="text-text-secondary">Price</dt>
          <dd className="font-medium text-text-primary">
            {current.price
              ? money(current.price.amountMinorUnits, current.price.currency, current.price.interval)
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-text-secondary">Payment method</dt>
          <dd className="font-medium text-text-primary">
            {current.paymentMethodOnFile ? "On file" : "None"}
          </dd>
        </div>
      </dl>

      <div ref={result} tabIndex={-1} className="focus:outline-none">
        {state.outcome?.kind === "ok" ? (
          <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
            Billing started. The owner can now set up payment from their Billing page. Nothing has
            been charged.
          </p>
        ) : (
          <Refusal outcome={state.outcome} standalone />
        )}
      </div>

      {current.state === "COMPLIMENTARY" && isFounding ? (
        <p className="text-sm text-text-secondary">
          Founding businesses are complimentary and are never billed.
        </p>
      ) : null}

      {canStart && prices.length === 0 ? (
        <p className="text-sm text-text-secondary">
          This business&apos;s plan has no current price. Add one on the Plans page first.
        </p>
      ) : null}

      {canStart && prices.length > 0 && state.outcome?.kind !== "ok" ? (
        <form
          action={formAction}
          onSubmit={(event) => {
            if (pending) event.preventDefault();
          }}
          className="flex flex-col gap-3"
        >
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="planPriceId" value={priceId} />
          {!reviewing ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${id}-price`} className="text-sm font-medium text-text-primary">
                  Start billing at
                </label>
                <select
                  id={`${id}-price`}
                  value={priceId}
                  onChange={(event) => setPriceId(event.target.value)}
                  className={SELECT}
                >
                  {prices.map((price) => (
                    <option key={price.id} value={price.id}>
                      {money(price.amountMinorUnits, price.currency, price.interval)}
                    </option>
                  ))}
                </select>
              </div>
              <button
                ref={reviewButton}
                type="button"
                onClick={() => setReviewing(true)}
                className={SECONDARY}
              >
                Review
              </button>
            </div>
          ) : (
            <div
              ref={confirmRegion}
              tabIndex={-1}
              role="group"
              aria-label="Confirm starting billing"
              className="flex flex-col gap-2 rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary focus:outline-none"
            >
              <p>
                Start billing this business at{" "}
                <strong>
                  {selected ? money(selected.amountMinorUnits, selected.currency, selected.interval) : ""}
                </strong>
                ? The owner is asked to set up payment; nothing is charged until they do, and a
                trial (when offered) comes first.
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="submit" aria-disabled={pending} aria-busy={pending} className={PRIMARY}>
                  {pending ? "Starting…" : "Start billing"}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    returnFocus.current = true;
                    setReviewing(false);
                  }}
                  className={SECONDARY}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </form>
      ) : null}
    </div>
  );
}
