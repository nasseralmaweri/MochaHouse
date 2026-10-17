"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { AdminPlanOption, BillingPlanChangePreview } from "@mocha-house/contracts";
import { formatDeadline } from "@/lib/admin/billing";
import {
  PLAN_CHANGE_MESSAGES,
  canConfirm,
  chargeLines,
  money,
  nextChargeSentence,
  optionLabel,
} from "@/lib/admin/plan-change";
import {
  confirmPlanChangeAction,
  previewPlanChangeAction,
  type PlanChangeState,
} from "./plan-actions";

const PRIMARY =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-contrast hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-disabled:cursor-wait aria-disabled:opacity-70";
const SECONDARY =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-border-default px-4 text-sm font-semibold text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-disabled:cursor-wait aria-disabled:opacity-70";
const SELECT =
  "min-h-11 w-full max-w-full rounded-lg border border-border-default bg-surface-card px-3 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

const IDLE: PlanChangeState = { kind: "idle" };

// The provider's charge, line by line, adding up to "Charged now".
function Charge({ preview }: { preview: BillingPlanChangePreview }) {
  const lines = chargeLines(preview);
  return (
    <div className="flex flex-col gap-2 text-sm">
      {lines.length > 0 ? (
        <dl className="flex flex-col gap-1">
          {lines.map((line) => (
            <div key={line.label} className="flex flex-wrap justify-between gap-x-4">
              <dt className="text-text-secondary">{line.label}</dt>
              <dd className={line.total ? "font-semibold text-text-primary" : "text-text-primary"}>
                {line.amount}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="text-text-primary">{nextChargeSentence(preview)}</p>
    </div>
  );
}

// SC3d-2 — choose a plan, see the payment provider's own price for the
// change, and confirm exactly that charge. A completed change is only ever
// shown once the API reports it applied (payment and price verified) — by
// the page's status line, not here.
export function ChangePlanPanel({ options }: { options: AdminPlanOption[] }) {
  const choices = options.filter((option) => !option.current);
  const [previewState, previewAction, previewing] = useActionState(previewPlanChangeAction, IDLE);
  const [confirmState, confirmAction, confirming] = useActionState(confirmPlanChangeAction, IDLE);
  const [priceId, setPriceId] = useState(choices[0]?.planPriceId ?? "");
  // Previews the owner left (Cancel, another plan, a refused confirmation).
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  // Previews whose hold has run out while the page was open.
  const [expired, setExpired] = useState<ReadonlySet<string>>(new Set());
  const id = useId();
  const selectRef = useRef<HTMLSelectElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const returnFocus = useRef(false);

  // A confirmation refused because the price moved or the preview is gone
  // withdraws that preview (it can never be confirmed).
  const withdrawn = (previewId: string) =>
    dismissed.has(previewId) ||
    (confirmState.kind === "error" &&
      confirmState.stalePreview === true &&
      confirmState.previewId === previewId);
  const preview =
    previewState.kind === "preview" && !withdrawn(previewState.preview.previewId)
      ? previewState.preview
      : null;
  const confirmable = preview !== null && !expired.has(preview.previewId) && canConfirm(preview);
  // A refusal belongs to the preview it was for; a new preview clears it.
  const confirmError =
    confirmState.kind === "error" &&
    (!preview || confirmState.previewId === undefined || confirmState.previewId === preview.previewId)
      ? confirmState.message
      : null;
  const previewError = previewState.kind === "error" ? previewState.message : null;
  const error = confirmError ?? (preview ? null : previewError);

  // The hold ends while the page is open: the confirmation goes away.
  useEffect(() => {
    if (!preview || expired.has(preview.previewId)) return;
    const left = new Date(preview.expiresAt).getTime() - Date.now();
    const timer = setTimeout(
      () => setExpired((current) => new Set(current).add(preview.previewId)),
      Math.max(0, left),
    );
    return () => clearTimeout(timer);
  }, [preview, expired]);

  useEffect(() => {
    if (preview) reviewRef.current?.focus();
  }, [preview]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error, confirmState, previewState]);
  useEffect(() => {
    if (!preview && returnFocus.current) selectRef.current?.focus();
    returnFocus.current = false;
  }, [preview]);

  if (choices.length === 0) {
    return <p className="text-sm text-text-secondary">No other plans are available right now.</p>;
  }

  const leave = () => {
    if (preview) {
      returnFocus.current = true;
      setDismissed((current) => new Set(current).add(preview.previewId));
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h2 id={`${id}-title`} className="text-base font-semibold text-text-primary">
        Change plan
      </h2>
      <p role="status" className="sr-only">
        {previewing ? "Getting the price…" : confirming ? "Confirming your payment…" : ""}
      </p>
      {error ? (
        <p
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error focus:outline-none"
        >
          {error}
        </p>
      ) : null}
      {confirmState.kind === "done" ? (
        <p className="text-sm text-text-secondary">
          Your plan change was submitted. Its status is shown above.
        </p>
      ) : (
        <>
          <form
            action={previewAction}
            onSubmit={(event) => {
              if (previewing || confirming) event.preventDefault();
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-auto">
              <label htmlFor={`${id}-plan`} className="text-sm font-medium text-text-primary">
                New plan
              </label>
              <select
                ref={selectRef}
                id={`${id}-plan`}
                name="planPriceId"
                value={priceId}
                onChange={(event) => {
                  setPriceId(event.target.value);
                  leave();
                }}
                className={SELECT}
              >
                {choices.map((option) => (
                  <option key={option.planPriceId} value={option.planPriceId}>
                    {optionLabel(option)}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" aria-disabled={previewing} aria-busy={previewing} className={SECONDARY}>
              {previewing ? "Getting the price…" : preview ? "Get a new price" : "See price"}
            </button>
          </form>
          {preview ? (
            <div
              ref={reviewRef}
              tabIndex={-1}
              role="group"
              aria-labelledby={`${id}-review`}
              className="flex flex-col gap-3 rounded-lg bg-surface-subtle px-3 py-3 text-sm text-text-primary focus:outline-none"
            >
              <p id={`${id}-review`} className="font-medium">
                {preview.current.planName} → {preview.target.planName}
              </p>
              <Charge preview={preview} />
              {confirmable ? (
                <>
                  <p id={`${id}-terms`} className="text-xs text-text-secondary">
                    Calculated by our payment provider and held until {formatDeadline(preview.expiresAt)}.
                    Confirming charges your saved payment method{" "}
                    {money(preview.chargeNow!.amountDueMinorUnits, preview.chargeNow!.currency)} now. The new
                    plan starts once the payment is confirmed; until then your current plan stays active.
                  </p>
                  <form
                    action={confirmAction}
                    onSubmit={(event) => {
                      if (confirming) event.preventDefault();
                    }}
                    className="flex flex-wrap gap-2"
                  >
                    <input type="hidden" name="previewId" value={preview.previewId} />
                    <button
                      type="submit"
                      aria-disabled={confirming}
                      aria-busy={confirming}
                      aria-describedby={`${id}-terms`}
                      className={PRIMARY}
                    >
                      {confirming
                        ? "Confirming…"
                        : `Confirm and pay ${money(preview.chargeNow!.amountDueMinorUnits, preview.chargeNow!.currency)}`}
                    </button>
                    <button
                      type="button"
                      aria-disabled={confirming}
                      onClick={() => {
                        if (!confirming) leave();
                      }}
                      className={SECONDARY}
                    >
                      Cancel
                    </button>
                  </form>
                </>
              ) : (
                <p className="text-sm text-text-secondary">
                  {preview.timing === "IMMEDIATE"
                    ? PLAN_CHANGE_MESSAGES.expired
                    : PLAN_CHANGE_MESSAGES.laterOnly}
                </p>
              )}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
