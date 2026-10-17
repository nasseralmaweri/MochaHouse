"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import type {
  PlatformAdjustableInvoice,
  PlatformAdjustmentPreview,
  PlatformAdjustmentView,
} from "@mocha-house/contracts";
import {
  previewAdjustmentAction,
  requestAdjustmentAction,
  type BillingActionState,
} from "@/lib/platform/billing-actions";
import { APPROVAL_POLICY, FUTURE_CHARGES, NO_ACCESS_EFFECTS, money } from "@/lib/platform/adjustments";
import { PRIMARY, Refusal, SECONDARY, SELECT } from "./SubscriptionPanel";

const TEXTAREA =
  "min-h-20 w-full rounded-lg border border-border-default bg-surface-card px-3 py-2 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const PREVIEW: BillingActionState<PlatformAdjustmentPreview> = { outcome: null };
const REQUEST: BillingActionState<PlatformAdjustmentView> = { outcome: null };

interface Choice {
  kind: "REFUND" | "CREDIT";
  scope: "FULL" | "PARTIAL";
  lineId: string;
  amount: string;
}

// SC3e-3 — requesting a refund or credit on one paid invoice: the payment
// provider previews the exact amount and tax first (nothing recorded); the
// request then records that preview with a reason. Nothing is refunded or
// credited until other operators approve it.
export function AdjustmentRequestForm({
  tenantId,
  invoice,
}: {
  tenantId: string;
  invoice: PlatformAdjustableInvoice;
}) {
  const id = useId();
  const [choice, setChoice] = useState<Choice>({
    kind: invoice.refundable ? "REFUND" : "CREDIT",
    scope: invoice.adjustedMinorUnits > 0 ? "PARTIAL" : "FULL",
    lineId: invoice.lines[0]?.lineId ?? "",
    amount: "",
  });
  const [previewState, previewAction, previewing] = useActionState(previewAdjustmentAction, PREVIEW);
  const [requestState, requestAction, requesting] = useActionState(requestAdjustmentAction, REQUEST);
  // The preview shown is for exactly the choice submitted; any change asks
  // again.
  const [submitted, setSubmitted] = useState<Choice | null>(null);
  const update = (next: Partial<Choice>) => setChoice((current) => ({ ...current, ...next }));
  const preview =
    submitted !== null && sameChoice(submitted, choice) && previewState.outcome?.kind === "ok"
      ? previewState.outcome.data
      : null;
  const result = useRef<HTMLDivElement>(null);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (requestState.outcome) result.current?.focus();
  }, [requestState]);
  // A new preview: its confirmation step is focused; a refusal is.
  useEffect(() => {
    if (previewState.outcome?.kind === "ok") confirmHeading.current?.focus();
    else if (previewState.outcome) result.current?.focus();
  }, [previewState]);

  if (requestState.outcome?.kind === "ok") {
    const view = requestState.outcome.data;
    return (
      <div ref={result} tabIndex={-1} role="status" className="flex flex-col gap-3 rounded-2xl border border-border-default bg-surface-card p-5 text-sm focus:outline-none">
        <p className="font-semibold text-text-primary">Requested. Nothing has been refunded or credited yet.</p>
        <p className="text-text-primary">
          It needs {view.requiredApprovals === 1 ? "one approval" : "two approvals"} from other operators within 72
          hours.
        </p>
        <Link href={`/platform/billing/adjustments/${view.id}`} className="font-medium underline underline-offset-2">
          Open the request
        </Link>
      </div>
    );
  }

  const hidden = (
    <>
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="invoiceId" value={invoice.invoiceId} />
      <input type="hidden" name="kind" value={choice.kind} />
      <input type="hidden" name="scope" value={choice.scope} />
      {choice.scope === "PARTIAL" ? (
        <>
          <input type="hidden" name="lineId" value={choice.lineId} />
          <input type="hidden" name="amount" value={choice.amount.trim()} />
        </>
      ) : null}
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <form
        action={previewAction}
        onSubmit={(event) => {
          if (previewing) event.preventDefault();
          else setSubmitted(choice);
        }}
        className="flex flex-col gap-3 rounded-2xl border border-border-default bg-surface-card p-5"
        aria-labelledby={`${id}-choose`}
      >
        <h2 id={`${id}-choose`} className="text-base font-semibold text-text-primary">
          1. Choose
        </h2>
        {hidden}
        <p className="rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-text-primary">{NO_ACCESS_EFFECTS}</p>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-text-primary">What</legend>
          <label className="flex min-h-11 items-start gap-2 text-sm text-text-primary">
            <input
              type="radio"
              checked={choice.kind === "REFUND"}
              disabled={!invoice.refundable}
              onChange={() => update({ kind: "REFUND" })}
              className="mt-1"
            />
            <span>
              Refund — money goes back to the original payment method
              {invoice.refundable ? "" : " (not possible: this invoice wasn't paid by a refundable charge)"}
            </span>
          </label>
          <label className="flex min-h-11 items-start gap-2 text-sm text-text-primary">
            <input
              type="radio"
              checked={choice.kind === "CREDIT"}
              onChange={() => update({ kind: "CREDIT" })}
              className="mt-1"
            />
            <span>Credit — reduces the business&apos;s future invoices (no money is returned)</span>
          </label>
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-text-primary">How much</legend>
          <label className="flex min-h-11 items-start gap-2 text-sm text-text-primary">
            <input
              type="radio"
              checked={choice.scope === "FULL"}
              disabled={invoice.adjustedMinorUnits > 0}
              onChange={() => update({ scope: "FULL" })}
              className="mt-1"
            />
            <span>
              The whole invoice
              {invoice.adjustedMinorUnits > 0 ? " (not possible: part of it was already refunded or credited)" : ""}
            </span>
          </label>
          <label className="flex min-h-11 items-start gap-2 text-sm text-text-primary">
            <input
              type="radio"
              checked={choice.scope === "PARTIAL"}
              onChange={() => update({ scope: "PARTIAL" })}
              className="mt-1"
            />
            <span>Part of one line (an amount before tax; the payment provider adds the tax)</span>
          </label>
          {choice.scope === "PARTIAL" ? (
            <div className="flex flex-col gap-2 pl-6">
              <label htmlFor={`${id}-line`} className="text-sm text-text-primary">
                Line
              </label>
              <select
                id={`${id}-line`}
                value={choice.lineId}
                onChange={(event) => update({ lineId: event.target.value })}
                className={SELECT}
              >
                {invoice.lines.map((line) => (
                  <option key={line.lineId} value={line.lineId}>
                    {line.description ?? "Subscription"} — {money(line.amountMinorUnits, invoice.currency)} before tax
                  </option>
                ))}
              </select>
              <label htmlFor={`${id}-amount`} className="text-sm text-text-primary">
                Amount before tax ({invoice.currency})
              </label>
              <input
                id={`${id}-amount`}
                inputMode="decimal"
                autoComplete="off"
                value={choice.amount}
                onChange={(event) => update({ amount: event.target.value })}
                className={SELECT}
                aria-describedby={`${id}-amount-help`}
              />
              <p id={`${id}-amount-help`} className="text-xs text-text-secondary">
                For example 25 or 25.50.
              </p>
            </div>
          ) : null}
        </fieldset>
        <p role="status" className="sr-only">
          {previewing ? "Asking the payment provider for a preview." : ""}
        </p>
        <button type="submit" aria-disabled={previewing} className={`${SECONDARY} self-start`}>
          {previewing ? "Asking the payment provider…" : "Preview with the payment provider"}
        </button>
      </form>

      <div ref={result} tabIndex={-1} className="flex flex-col gap-2 focus:outline-none">
        {!preview ? <Refusal outcome={previewState.outcome} /> : null}
        <Refusal outcome={requestState.outcome} />
      </div>

      {preview ? (
        <form
          action={requestAction}
          onSubmit={(event) => {
            if (requesting) event.preventDefault();
          }}
          className="flex flex-col gap-3 rounded-2xl border border-border-default bg-surface-card p-5"
          aria-labelledby={`${id}-confirm`}
        >
          <h2
            id={`${id}-confirm`}
            ref={confirmHeading}
            tabIndex={-1}
            className="text-base font-semibold text-text-primary focus:outline-none"
          >
            2. Request
          </h2>
          <p role="status" className="text-sm text-text-primary">
            Preview ready: {preview.kind === "REFUND" ? "refund" : "credit"} of{" "}
            {money(preview.totalMinorUnits, preview.currency)} including {money(preview.taxMinorUnits, preview.currency)}{" "}
            tax. Next, give a reason and request approval.
          </p>
          {hidden}
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-text-secondary">{preview.kind === "REFUND" ? "Refund" : "Credit"}</dt>
              <dd className="font-semibold text-text-primary">{money(preview.totalMinorUnits, preview.currency)}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-text-secondary">Of which tax</dt>
              <dd className="text-text-primary">{money(preview.taxMinorUnits, preview.currency)}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-text-secondary">Left on the invoice after</dt>
              <dd className="text-text-primary">{money(preview.remainingAfterMinorUnits, preview.currency)}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-text-secondary">Approvals needed</dt>
              <dd className="text-text-primary">
                {preview.requiredApprovals === 1 ? "One other operator" : "Two other operators"}
                {preview.annualFullRefund ? " (full refund of an annual period)" : ""}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-text-secondary">{APPROVAL_POLICY}</p>
          <p className="rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-text-primary">{NO_ACCESS_EFFECTS}</p>
          <label htmlFor={`${id}-reason`} className="text-sm font-medium text-text-primary">
            Reason (required; the approvers and the audit trail see it)
          </label>
          <textarea id={`${id}-reason`} name="reason" required minLength={10} maxLength={500} className={TEXTAREA} />
          <label className="flex min-h-11 items-start gap-2 text-sm text-text-primary">
            <input type="checkbox" name="understood" value="yes" required className="mt-1" />
            I understand: {FUTURE_CHARGES} This doesn&apos;t cancel or change the subscription.
          </label>
          <button type="submit" aria-disabled={requesting} className={`${PRIMARY} self-start`}>
            {requesting ? "Requesting…" : "Request approval"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function sameChoice(a: Choice, b: Choice): boolean {
  return (
    a.kind === b.kind &&
    a.scope === b.scope &&
    (a.scope === "FULL" || (a.lineId === b.lineId && a.amount.trim() === b.amount.trim()))
  );
}
