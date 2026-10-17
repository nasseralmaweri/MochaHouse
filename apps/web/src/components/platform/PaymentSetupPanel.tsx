"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import type { PlatformPaymentSetupView, PlatformTenantBillingResponse } from "@mocha-house/contracts";
import { extendPaymentSetupAction, type BillingActionState } from "@/lib/platform/billing-actions";
import { PRIMARY, Refusal, SELECT } from "./SubscriptionPanel";

const INPUT =
  "min-h-10 w-full rounded-lg border border-border-default bg-surface-card px-3 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const INITIAL: BillingActionState<PlatformTenantBillingResponse> = { outcome: null };

const when = (iso: string) =>
  `${new Date(iso).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" })} UTC`;

// SC3e-4 — a business that still needs payment setup: since when, its
// deadline (only while billing enforcement is on), the latest an operator
// may extend it to (30 days from the window's start), and the extensions so
// far. Extending needs billing.accounts.manage (the API enforces it).
export function PaymentSetupPanel({
  tenantId,
  setup,
  canExtend,
}: {
  tenantId: string;
  setup: PlatformPaymentSetupView;
  canExtend: boolean;
}) {
  const [state, formAction, pending] = useActionState(extendPaymentSetupAction, INITIAL);
  const id = useId();
  const result = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.outcome?.kind === "ok") form.current?.reset();
    if (state.outcome) result.current?.focus();
  }, [state]);
  const extendable = setup.enforced && setup.deadline !== null && !setup.expired;
  // Why the deadline can't be extended here (null: it can).
  const unavailable = !canExtend
    ? "Extending the deadline needs billing.accounts.manage."
    : setup.expired
      ? "The deadline has passed, so it can't be extended. The business is restored once payment is set up and confirmed."
      : !setup.enforced
        ? "Billing enforcement is off, so there is no deadline to extend."
        : setup.deadline === null
          ? "The deadline is set at the next billing sweep; it can be extended after that."
          : null;
  const message =
    state.outcome?.kind === "ok" ? "Deadline extended and recorded in the audit trail." : "";
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-2xl border border-border-default bg-surface-card p-5 text-sm"
    >
      <h3 id={`${id}-title`} className="text-base font-semibold text-text-primary">
        Payment setup
      </h3>
      {setup.expired ? (
        <p className="rounded-lg bg-status-warning/10 px-3 py-2 text-text-primary">
          The deadline passed: the business is paused for billing until payment is set up and confirmed.
        </p>
      ) : null}
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-text-secondary">Needed since</dt>
          <dd className="text-text-primary">{when(setup.since)}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-text-secondary">Deadline</dt>
          <dd className="text-text-primary">
            {setup.deadline
              ? when(setup.deadline)
              : setup.enforced
                ? "Set at the next billing sweep"
                : "None — billing enforcement is off"}
          </dd>
        </div>
        {setup.latestDeadline && !setup.expired ? (
          <div className="flex flex-wrap gap-x-2 sm:col-span-2">
            <dt className="text-text-secondary">Can be extended to at most</dt>
            <dd className="text-text-primary">{when(setup.latestDeadline)}</dd>
          </div>
        ) : null}
      </dl>
      {setup.extensions.length > 0 ? (
        <ul aria-label="Deadline extensions" className="flex flex-col gap-1">
          {setup.extensions.map((e) => (
            <li key={e.id} className="break-words rounded-lg bg-surface-subtle px-3 py-2 text-text-primary">
              Extended by {e.days} day{e.days === 1 ? "" : "s"} to {when(e.newEndsAt)} by {e.operatorEmail}: {e.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {extendable && unavailable === null ? (
        <form
          ref={form}
          action={formAction}
          onSubmit={(event) => {
            if (pending) event.preventDefault();
          }}
          className="flex flex-col gap-2"
          aria-label="Extend the payment setup deadline"
        >
          <input type="hidden" name="tenantId" value={tenantId} />
          <label htmlFor={`${id}-days`} className="font-medium text-text-primary">
            Extend by
          </label>
          <select id={`${id}-days`} name="days" defaultValue="7" className={SELECT}>
            {Array.from({ length: 14 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d} day{d === 1 ? "" : "s"}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-reason`} className="font-medium text-text-primary">
            Reason (required)
          </label>
          <input
            id={`${id}-reason`}
            name="reason"
            required
            minLength={10}
            maxLength={500}
            autoComplete="off"
            aria-describedby={`${id}-reason-help`}
            aria-invalid={state.outcome?.kind === "error" || undefined}
            className={INPUT}
          />
          <p id={`${id}-reason-help`} className="text-xs text-text-secondary">
            10 to 500 characters. The business doesn&apos;t see it; it is kept with the extension.
          </p>
          <div ref={result} tabIndex={-1} className="flex flex-col gap-2 focus:outline-none">
            <p role="status" className={message ? "rounded-lg bg-surface-subtle px-3 py-2 text-text-primary" : "sr-only"}>
              {message}
            </p>
            <Refusal outcome={state.outcome} />
          </div>
          <button type="submit" aria-disabled={pending} className={`${PRIMARY} self-start`}>
            {pending ? "Saving…" : "Extend deadline"}
          </button>
        </form>
      ) : unavailable ? (
        <p className="text-text-secondary">{unavailable}</p>
      ) : null}
    </section>
  );
}
