"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { PaymentCaseCategory, PlatformPaymentCaseDetail } from "@mocha-house/contracts";
import { platformSignOutAction } from "@/lib/platform-auth/actions";
import {
  paymentCaseAction,
  type PaymentCaseFormState,
} from "@/lib/platform/payment-case-actions";
import {
  CATEGORY_HINT,
  CATEGORY_LABEL,
  EVENT_LABEL,
  FAILURE_LABEL,
  PAYMENT_CASE_MESSAGES,
  REASON_LABEL,
  STATUS_LABEL,
  formatMinorUnits,
  labelOf,
  validNote,
  validRecoveryReason,
} from "@/lib/platform/payment-cases";
import { formatPlatformTime } from "@/lib/platform/onboarding";
import { PlatformCard } from "./PlatformCards";
import { platformInputClassName } from "./PlatformAuthFrame";

// ESP-03 PR 5 — one restaurant payment case in the Platform Console: where it
// stands, the payment and order references, the recovery history, internal
// notes, and (with payments.reconciliation.manage) a safe recovery request.
// The API decides whether anything can be recovered; a recovery never
// charges a customer again.

const INITIAL: PaymentCaseFormState = { outcome: null, fieldError: null };

const PRIMARY =
  "inline-flex min-h-10 w-fit items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-contrast hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-wait disabled:opacity-70";
const SECONDARY =
  "inline-flex min-h-10 w-fit items-center rounded-lg border border-border-default px-3 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

const BADGE: Record<PaymentCaseCategory, string> = {
  NEEDS_ATTENTION: "bg-status-warning/15 text-status-warning",
  RECOVERY_IN_PROGRESS: "bg-surface-subtle text-text-primary",
  RECOVERED: "bg-status-success/15 text-status-success",
  AWAITING_PAYMENT_OUTCOME: "bg-surface-subtle text-text-secondary",
  CLOSED: "bg-surface-subtle text-text-secondary",
};

export function PaymentCaseCategoryBadge({ category }: { category: PaymentCaseCategory }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${BADGE[category]}`}>
      {CATEGORY_LABEL[category]}
    </span>
  );
}

export function PaymentCasePanel({
  detail,
  canManage,
}: {
  detail: PlatformPaymentCaseDetail;
  canManage: boolean;
}) {
  const { case: row, events, notes } = detail;
  const { payment, recovery } = row;
  return (
    <div className="flex flex-col gap-4">
      <PlatformCard title="Where it stands">
        <div className="flex flex-wrap items-center gap-2">
          <PaymentCaseCategoryBadge category={row.category} />
          <span className="text-sm text-text-secondary">Case {STATUS_LABEL[row.status].toLowerCase()}</span>
        </div>
        <p className="text-sm text-text-primary">{CATEGORY_HINT[row.category]}</p>
        <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-text-secondary">Business</dt>
          <dd className="text-text-primary">{row.tenant.name}</dd>
          <dt className="text-text-secondary">Reason</dt>
          <dd className="text-text-primary">{labelOf(REASON_LABEL, row.reasonCode)}</dd>
          <dt className="text-text-secondary">Opened</dt>
          <dd className="text-text-primary">{formatPlatformTime(row.createdAt)}</dd>
          {row.resolvedAt ? (
            <>
              <dt className="text-text-secondary">Resolved</dt>
              <dd className="text-text-primary">
                {formatPlatformTime(row.resolvedAt)}
                {row.resolution ? ` · ${row.resolution.toLowerCase().replace(/_/g, " ")}` : ""}
              </dd>
            </>
          ) : null}
        </dl>
      </PlatformCard>

      <PlatformCard title="Payment and order">
        <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-text-secondary">Amount charged</dt>
          <dd className="text-text-primary">{formatMinorUnits(payment.amountMinorUnits, payment.currency)}</dd>
          <dt className="text-text-secondary">Payment state</dt>
          <dd className="text-text-primary">
            {payment.status}
            {payment.paymentState ? ` · ${payment.paymentState}` : ""}
            {payment.fulfilmentStatus ? ` · fulfilment ${payment.fulfilmentStatus}` : ""}
          </dd>
          <dt className="text-text-secondary">Payment reference</dt>
          <dd className="break-all font-mono text-text-primary">{payment.id}</dd>
          <dt className="text-text-secondary">Provider reference</dt>
          <dd className="break-all font-mono text-text-primary">{payment.providerReference ?? "—"}</dd>
          <dt className="text-text-secondary">For</dt>
          <dd className="text-text-primary">
            {row.purchaseKind === "GIFT_CARD" ? "Gift card purchase" : row.purchaseKind === "ORDER" ? "Order" : "Unknown"}
          </dd>
          <dt className="text-text-secondary">Order</dt>
          <dd className="text-text-primary">
            {row.order ? (
              <>
                {row.order.orderNumber} <span className="break-all font-mono text-text-secondary">({row.order.id})</span>
              </>
            ) : row.giftCardPurchase ? (
              <>
                {row.giftCardPurchase.issued ? "Gift card issued" : "Gift card not issued"}{" "}
                <span className="break-all font-mono text-text-secondary">({row.giftCardPurchase.id})</span>
              </>
            ) : (
              "None"
            )}
          </dd>
        </dl>
      </PlatformCard>

      <PlatformCard title="Recovery">
        <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-text-secondary">Can be recovered</dt>
          <dd className="text-text-primary">{recovery.recoverable ? "Yes" : "No"}</dd>
          <dt className="text-text-secondary">Automatic attempts</dt>
          <dd className="text-text-primary">{recovery.automaticAttempts}</dd>
          <dt className="text-text-secondary">Last failure</dt>
          <dd className="text-text-primary">
            {recovery.lastFailure
              ? `${labelOf(FAILURE_LABEL, recovery.lastFailure)} (${formatPlatformTime(recovery.lastFailureAt)})`
              : "—"}
          </dd>
          <dt className="text-text-secondary">Next automatic attempt</dt>
          <dd className="text-text-primary">
            {recovery.nextAutomaticAttemptAt
              ? formatPlatformTime(recovery.nextAutomaticAttemptAt)
              : detail.automaticRecoveryEnabled
                ? "None scheduled"
                : "Automatic recovery is off"}
          </dd>
        </dl>
        {canManage && recovery.recoverable ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium text-text-primary">Recover now</summary>
            <PaymentCaseForm caseId={row.id} intent="recover" />
          </details>
        ) : null}
        {!recovery.recoverable && row.category === "AWAITING_PAYMENT_OUTCOME" ? (
          <p className="text-sm text-text-secondary">
            Recovery is not possible until the payment provider confirms the payment. Do not ask the customer to
            pay again.
          </p>
        ) : null}
      </PlatformCard>

      <PlatformCard title={`History (${events.length})`}>
        {events.length === 0 ? (
          <p className="text-sm text-text-secondary">No history recorded.</p>
        ) : (
          <ol className="flex flex-col gap-2 text-sm">
            {events.map((event) => (
              <li key={event.id} className="rounded-lg bg-surface-subtle px-3 py-2">
                <p className="font-medium text-text-primary">
                  {labelOf(EVENT_LABEL, event.action)} · {formatPlatformTime(event.createdAt)} ·{" "}
                  {event.actor === "SYSTEM" ? "System" : "Restaurant staff"}
                </p>
                {Object.keys(event.detail).length > 0 ? (
                  <p className="break-all font-mono text-xs text-text-secondary">
                    {Object.entries(event.detail)
                      .map(([key, value]) => `${key}: ${String(value)}`)
                      .join(" · ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </PlatformCard>

      <PlatformCard title={`Internal notes (${notes.length})`}>
        <p className="text-xs text-text-muted">
          Notes are visible to CENTERIVO platform support only and cannot be edited or deleted. Do not include card
          numbers, gift-card codes or customer contact details.
        </p>
        {notes.length > 0 ? (
          <ul className="flex flex-col gap-2 text-sm">
            {notes.map((note) => (
              <li key={note.id} className="rounded-lg bg-surface-subtle px-3 py-2">
                <p className="font-medium text-text-primary">
                  {note.authorEmail} · {formatPlatformTime(note.createdAt)}
                </p>
                <p className="whitespace-pre-wrap break-words text-text-secondary">{note.body}</p>
              </li>
            ))}
          </ul>
        ) : null}
        {canManage ? <PaymentCaseForm caseId={row.id} intent="note" /> : null}
      </PlatformCard>
    </div>
  );
}

function PaymentCaseForm({ caseId, intent }: { caseId: string; intent: "recover" | "note" }) {
  // Controlled, so typed text survives a refusal (sign-in, rate limit,
  // network) instead of being reset with the form.
  const [value, setValue] = useState("");
  const [state, formAction, pending] = useActionState(
    async (previous: PaymentCaseFormState, form: FormData) => {
      const next = await paymentCaseAction(previous, form);
      if (next.outcome?.kind === "ok") setValue("");
      return next;
    },
    INITIAL,
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const message = useRef<HTMLDivElement>(null);
  const fieldId = useId();
  const hintId = useId();
  const errorId = useId();
  const outcome = state.outcome;
  const fieldError = localError ?? state.fieldError;
  const recover = intent === "recover";

  // After each answer, focus moves to the result so it is read out; a field
  // the server refused gets the focus instead, so it can be fixed.
  useEffect(() => {
    if (state === INITIAL) return;
    if (state.outcome) message.current?.focus();
    else if (state.fieldError) fieldRef.current?.focus();
  }, [state]);

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        const ok = recover ? validRecoveryReason(value) : validNote(value);
        if (!ok) {
          event.preventDefault();
          setLocalError(recover ? PAYMENT_CASE_MESSAGES.reason : PAYMENT_CASE_MESSAGES.note);
          fieldRef.current?.focus();
          return;
        }
        setLocalError(null);
      }}
      className="mt-2 flex flex-col gap-3"
    >
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="intent" value={intent} />
      <p id={hintId} className="text-xs text-text-muted">
        {recover
          ? "Creates the missing order or gift card from what was saved before payment. It never charges the customer and is refused for a payment that is not confirmed. The reason (10–500 characters) is kept as a note and in the audit log."
          : "Add an internal note (up to 1,000 characters). It is kept permanently."}
      </p>
      <label htmlFor={fieldId} className="text-sm font-medium text-text-primary">
        {recover ? "Reason" : "Note"}
      </label>
      <textarea
        ref={fieldRef}
        id={fieldId}
        name={recover ? "reason" : "body"}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={3}
        maxLength={recover ? 500 : 1000}
        required
        aria-describedby={fieldError ? `${hintId} ${errorId}` : hintId}
        aria-invalid={fieldError ? true : undefined}
        className={platformInputClassName}
      />
      {fieldError ? (
        <p id={errorId} className="text-sm text-status-error">
          {fieldError}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className={recover ? PRIMARY : SECONDARY}>
        {pending ? "Working…" : recover ? "Recover now" : "Add note"}
      </button>
      <div ref={message} tabIndex={-1} aria-live="polite" className="text-sm focus:outline-none">
        {outcome?.kind === "ok" ? <p className="text-text-primary">{outcome.message}</p> : null}
        {outcome?.kind === "error" ? <p className="text-status-error">{outcome.message}</p> : null}
        {outcome?.kind === "reauth" ? (
          <div className="flex flex-col items-start gap-2 rounded-lg bg-status-warning/10 px-3 py-2 text-text-primary">
            <p role="alert">{PAYMENT_CASE_MESSAGES.reauth}</p>
            <button type="submit" formAction={platformSignOutAction} formNoValidate className={SECONDARY}>
              Sign out and sign in again
            </button>
          </div>
        ) : null}
      </div>
    </form>
  );
}
