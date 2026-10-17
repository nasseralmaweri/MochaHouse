"use client";

import { useActionState, useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  PlatformComplimentaryGrantView,
  PlatformComplimentaryView,
} from "@mocha-house/contracts";
import {
  endComplimentaryAction,
  grantComplimentaryAction,
  type BillingActionState,
} from "@/lib/platform/billing-actions";
import {
  COMPLIMENTARY_FINISH_LABELS,
  COMPLIMENTARY_STATUS_LABELS,
  PREVIOUS_STATUS_LABELS,
  grantAttention,
  grantEnd,
} from "@/lib/platform/complimentary";
import { formatMinorUnits } from "@/lib/admin/crm";
import { PRIMARY, Refusal, SECONDARY, SELECT } from "./SubscriptionPanel";

const TEXTAREA =
  "min-h-20 w-full rounded-lg border border-border-default bg-surface-card px-3 py-2 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const INITIAL: BillingActionState<PlatformComplimentaryView> = { outcome: null };

const date = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" });

// SC3e-2 — a business's complimentary arrangements in the console: what it
// is on, until when, who granted it and why, what it was billed as before,
// a pending payment-provider cancellation and anything needing attention.
// Granting, withdrawing and revoking appear only with
// billing.complimentary.manage (the API enforces it, and a recent sign-in).
export function ComplimentaryPanel({
  tenantId,
  view,
  versions,
  canManage,
}: {
  tenantId: string;
  view: PlatformComplimentaryView;
  versions: { id: string; label: string; moduleKeys: string[] }[];
  canManage: boolean;
}) {
  const current = view.current;
  // The outcome of a grant / withdrawal / revocation: kept here, so it is
  // still announced (and focused) after the page refreshes and the form
  // that made it is gone.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);
  const done = useCallback((message: string) => setNotice(message), []);
  return (
    <section aria-labelledby="tenant-complimentary" className="flex flex-col gap-3 rounded-2xl border border-border-default bg-surface-card p-5">
      <h3 id="tenant-complimentary" className="text-base font-semibold text-text-primary">
        Complimentary
      </h3>
      {notice ? (
        <p
          ref={noticeRef}
          tabIndex={-1}
          role="status"
          className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary focus:outline-none"
        >
          {notice}
        </p>
      ) : null}
      {view.legacyComplimentary ? (
        <p className="text-sm text-text-secondary">
          Complimentary with no arrangement on record (a Founding business, or billing never started).
        </p>
      ) : null}
      {current ? <GrantSummary grant={current} /> : null}
      {current && canManage ? <EndGrant tenantId={tenantId} grant={current} onDone={done} /> : null}
      {current && !canManage ? (
        <p className="text-sm text-text-secondary">
          Changing it needs billing.complimentary.manage; ask a CENTERIVO administrator.
        </p>
      ) : null}
      {!current && view.billingMode === "BILLED" ? (
        canManage ? (
          view.eligibility.eligible ? (
            <GrantForm tenantId={tenantId} versions={versions} onDone={done} />
          ) : (
            <p className="text-sm text-text-secondary">
              Can&apos;t be made complimentary right now: {view.eligibility.reason}
            </p>
          )
        ) : (
          <p className="text-sm text-text-secondary">
            Not complimentary. Granting needs billing.complimentary.manage.
          </p>
        )
      ) : null}
      {view.history.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-text-primary">
            Earlier arrangements ({view.history.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-3">
            {view.history.map((grant) => (
              <li key={grant.id} className="rounded-lg bg-surface-subtle px-3 py-2">
                <GrantSummary grant={grant} compact />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function GrantSummary({ grant, compact = false }: { grant: PlatformComplimentaryGrantView; compact?: boolean }) {
  const attention = grantAttention(grant);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="font-medium text-text-primary">
        {COMPLIMENTARY_STATUS_LABELS[grant.status]} · {grant.plan.planName} (version {grant.plan.version}) ·{" "}
        {grantEnd(grant)}
      </p>
      {attention ? (
        <p role={compact ? undefined : "status"} className="rounded-lg bg-status-warning/10 px-3 py-2 text-text-primary">
          {attention}
        </p>
      ) : null}
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-text-secondary">Modules</dt>
          <dd className="break-words text-text-primary">{grant.plan.moduleKeys.join(", ") || "Core only"}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-text-secondary">Granted by</dt>
          <dd className="break-words text-text-primary">
            {grant.grantedBy.email} on {date(grant.createdAt)}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2 sm:col-span-2">
          <dt className="text-text-secondary">Reason</dt>
          <dd className="break-words text-text-primary">{grant.reason}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-text-secondary">Before</dt>
          <dd className="break-words text-text-primary">
            {PREVIOUS_STATUS_LABELS[grant.previousStatus] ?? grant.previousStatus} on {grant.previousPlanName},{" "}
            {formatMinorUnits(grant.previousPrice.amountMinorUnits, grant.previousPrice.currency)}{" "}
            {grant.previousPrice.interval === "MONTH" ? "per month" : "per year"}
          </dd>
        </div>
        {grant.status === "SCHEDULED" && grant.effectiveAt ? (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-text-secondary">Payment provider</dt>
            <dd className="text-text-primary">
              {grant.cancellationVerified ? "Cancels" : "Asked to cancel"} the paid subscription on{" "}
              {date(grant.effectiveAt)} (end of the paid period)
            </dd>
          </div>
        ) : null}
        {grant.startedAt ? (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-text-secondary">Started</dt>
            <dd className="text-text-primary">{date(grant.startedAt)}</dd>
          </div>
        ) : null}
        {grant.finishedAt ? (
          <div className="flex flex-wrap gap-x-2 sm:col-span-2">
            <dt className="text-text-secondary">Finished</dt>
            <dd className="break-words text-text-primary">
              {date(grant.finishedAt)} — {COMPLIMENTARY_FINISH_LABELS[grant.finishCode ?? ""] ?? grant.finishCode}
              {grant.finishedBy ? ` by ${grant.finishedBy.email}` : ""}
              {grant.finishReason ? `: ${grant.finishReason}` : ""}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function GrantForm({
  tenantId,
  versions,
  onDone,
}: {
  tenantId: string;
  versions: { id: string; label: string; moduleKeys: string[] }[];
  onDone: (message: string) => void;
}) {
  const [state, formAction, pending] = useActionState(grantComplimentaryAction, INITIAL);
  const [duration, setDuration] = useState<"indefinite" | "until">("indefinite");
  const id = useId();
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.outcome?.kind === "ok") {
      onDone(
        state.outcome.data.current?.status === "SCHEDULED"
          ? "Scheduled. The business keeps paying until its paid period ends; then the arrangement starts. Nothing was refunded or credited."
          : "The business is now complimentary. Nothing was refunded or credited.",
      );
    } else if (state.outcome) result.current?.focus();
  }, [state, onDone]);
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col gap-3"
      aria-describedby={`${id}-help`}
    >
      <input type="hidden" name="tenantId" value={tenantId} />
      <p id={`${id}-help`} className="text-sm text-text-secondary">
        A paying business becomes complimentary only after the period it already paid for: the payment provider
        is set to cancel at that period&apos;s end. Nothing is refunded or credited, and unpaid invoices must be
        settled first.
      </p>
      <label htmlFor={`${id}-plan`} className="text-sm font-medium text-text-primary">
        Plan it gets
      </label>
      <select id={`${id}-plan`} name="planVersionId" required defaultValue="" className={SELECT}>
        <option value="" disabled>
          Choose a plan version
        </option>
        {versions.map((version) => (
          <option key={version.id} value={version.id}>
            {version.label} — {version.moduleKeys.join(", ") || "core only"}
          </option>
        ))}
      </select>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-text-primary">How long</legend>
        <label className="flex min-h-11 items-center gap-2 text-sm text-text-primary">
          <input
            type="radio"
            name="duration"
            value="indefinite"
            checked={duration === "indefinite"}
            onChange={() => setDuration("indefinite")}
          />
          Indefinite
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm text-text-primary">
          <input
            type="radio"
            name="duration"
            value="until"
            checked={duration === "until"}
            onChange={() => setDuration("until")}
          />
          Until a date
        </label>
        {duration === "until" ? (
          <label className="flex flex-col gap-1 text-sm text-text-primary">
            End date (UTC)
            <input type="date" name="endDate" required className={SELECT} />
          </label>
        ) : null}
      </fieldset>
      <label htmlFor={`${id}-reason`} className="text-sm font-medium text-text-primary">
        Reason
      </label>
      <textarea
        id={`${id}-reason`}
        name="reason"
        required
        minLength={10}
        maxLength={500}
        aria-describedby={`${id}-help`}
        className={TEXTAREA}
      />
      <button type="submit" aria-disabled={pending} aria-busy={pending} className={`${PRIMARY} self-start`}>
        {pending ? "Saving…" : "Make complimentary"}
      </button>
      <div ref={result} tabIndex={-1} className="focus:outline-none">
        <Refusal outcome={state.outcome} standalone />
      </div>
    </form>
  );
}

function EndGrant({
  tenantId,
  grant,
  onDone,
}: {
  tenantId: string;
  grant: PlatformComplimentaryGrantView;
  onDone: (message: string) => void;
}) {
  const [state, formAction, pending] = useActionState(endComplimentaryAction, INITIAL);
  const id = useId();
  const result = useRef<HTMLDivElement>(null);
  const step = grant.status === "SCHEDULED" ? "withdraw" : "revoke";
  useEffect(() => {
    if (state.outcome?.kind === "ok") {
      onDone(
        step === "withdraw"
          ? "Withdrawn. The business keeps its paid subscription as before."
          : "Revoked. The business is back on billing and is asked to set up or restart payment. Nothing was charged, refunded or credited.",
      );
    } else if (state.outcome) result.current?.focus();
  }, [state, onDone, step]);
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="grantId" value={grant.id} />
      <input type="hidden" name="step" value={step} />
      <p id={`${id}-help`} className="text-sm text-text-secondary">
        {step === "withdraw"
          ? "Withdrawing undoes the cancellation at the payment provider: the business keeps paying as before."
          : "Revoking ends the arrangement now. The business returns to billing and is asked to set up or restart payment; once billing enforcement is on, an ended subscription keeps only what it needs to recover billing until then. Nothing is charged automatically, and nothing is refunded or credited."}
      </p>
      <label htmlFor={`${id}-reason`} className="text-sm font-medium text-text-primary">
        Reason
      </label>
      <textarea
        id={`${id}-reason`}
        name="reason"
        required
        minLength={10}
        maxLength={500}
        aria-describedby={`${id}-help`}
        className={TEXTAREA}
      />
      {step === "revoke" ? (
        <label className="flex min-h-11 items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" name="confirm" required />
          I understand the business returns to billing now.
        </label>
      ) : null}
      <button type="submit" aria-disabled={pending} aria-busy={pending} className={`${SECONDARY} self-start`}>
        {pending ? "Saving…" : step === "withdraw" ? "Withdraw the arrangement" : "Revoke the arrangement"}
      </button>
      <div ref={result} tabIndex={-1} className="focus:outline-none">
        <Refusal outcome={state.outcome} standalone />
      </div>
    </form>
  );
}
