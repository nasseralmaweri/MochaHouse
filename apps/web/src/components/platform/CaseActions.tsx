"use client";

import { useActionState, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  PLATFORM_CASE_OUTCOMES,
  type PlatformCaseDetailResponse,
  type PlatformCaseRecheckResponse,
} from "@mocha-house/contracts";
import {
  closeCaseAction,
  recheckCaseAction,
  releaseScheduleAction,
  type BillingActionState,
} from "@/lib/platform/billing-actions";
import { CASE_OUTCOME_LABELS, RECHECK_RESULT_LABELS } from "@/lib/platform/complimentary";
import { Refusal, SECONDARY, SELECT } from "./SubscriptionPanel";

const TEXTAREA =
  "min-h-20 w-full rounded-lg border border-border-default bg-surface-card px-3 py-2 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

// SC3e-2 — review-case actions. The API re-checks the permission (and, for a
// release, the recent sign-in and the exact schedule) on every request.
// The panel stays mounted when the page refreshes after an action (a closed
// case, a released schedule), so the outcome is still announced and focused.
export function CaseActionsPanel({
  caseId,
  open,
  canCases,
  canRelease,
  releasableScheduleId,
}: {
  caseId: string;
  open: boolean;
  canCases: boolean;
  canRelease: boolean;
  releasableScheduleId: string | null;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);
  const released = useCallback(
    () =>
      setNotice("The schedule was released. The subscription is unchanged; nothing was refunded or credited."),
    [],
  );
  const closed = useCallback(() => setNotice("The case is closed."), []);
  const showActions = open && (canCases || canRelease);
  return (
    <section aria-labelledby="case-actions" className="flex flex-col gap-5 rounded-2xl border border-border-default bg-surface-card p-5">
      <h2 id="case-actions" className="text-base font-semibold text-text-primary">
        Actions
      </h2>
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
      {showActions ? (
        <>
          {canCases ? <RecheckCase caseId={caseId} /> : null}
          {canRelease && releasableScheduleId ? (
            <ReleaseSchedule
              caseId={caseId}
              externalScheduleId={releasableScheduleId}
              onDone={released}
            />
          ) : null}
          {canCases ? <CloseCase caseId={caseId} onDone={closed} /> : null}
        </>
      ) : open ? (
        <p className="text-sm text-text-secondary">
          Your operator account can view this case but not act on it. Ask a CENTERIVO administrator for
          billing.cases.manage (and billing.schedules.release to release schedules).
        </p>
      ) : notice ? null : (
        <p className="text-sm text-text-secondary">This case is closed.</p>
      )}
    </section>
  );
}

function RecheckCase({ caseId }: { caseId: string }) {
  const [state, formAction, pending] = useActionState(
    recheckCaseAction,
    { outcome: null } as BillingActionState<PlatformCaseRecheckResponse>,
  );
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
      className="flex flex-col items-start gap-2"
    >
      <input type="hidden" name="caseId" value={caseId} />
      <button type="submit" aria-disabled={pending} aria-busy={pending} className={SECONDARY}>
        {pending ? "Checking…" : "Recheck with the payment provider"}
      </button>
      <p className="text-xs text-text-secondary">Reads the payment provider again. Nothing is changed there.</p>
      <div ref={result} tabIndex={-1} className="focus:outline-none">
        {state.outcome?.kind === "ok" ? (
          <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
            {RECHECK_RESULT_LABELS[state.outcome.data.result]}
          </p>
        ) : (
          <Refusal outcome={state.outcome} standalone />
        )}
      </div>
    </form>
  );
}

function ReleaseSchedule({
  caseId,
  externalScheduleId,
  onDone,
}: {
  caseId: string;
  externalScheduleId: string;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    releaseScheduleAction,
    { outcome: null } as BillingActionState<PlatformCaseDetailResponse>,
  );
  const id = useId();
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.outcome?.kind === "ok") onDone();
    else if (state.outcome) result.current?.focus();
  }, [state, onDone]);
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="externalScheduleId" value={externalScheduleId} />
      <p id={`${id}-help`} className="break-words text-sm text-text-primary">
        Releases schedule <span className="break-all font-mono">{externalScheduleId}</span> from this
        business&apos;s subscription. The subscription keeps running on its current price; it is never cancelled. No
        refund or credit is made.
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
      <label className="flex min-h-11 items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" name="confirm" required />
        I checked this schedule in the payment provider and want to release it.
      </label>
      <button type="submit" aria-disabled={pending} aria-busy={pending} className={`${SECONDARY} self-start`}>
        {pending ? "Releasing…" : "Release the schedule"}
      </button>
      <div ref={result} tabIndex={-1} className="focus:outline-none">
        <Refusal outcome={state.outcome} standalone />
      </div>
    </form>
  );
}

function CloseCase({ caseId, onDone }: { caseId: string; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(
    closeCaseAction,
    { outcome: null } as BillingActionState<{ resolved: true }>,
  );
  const id = useId();
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.outcome?.kind === "ok") onDone();
    else if (state.outcome) result.current?.focus();
  }, [state, onDone]);
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="caseId" value={caseId} />
      <label htmlFor={`${id}-outcome`} className="text-sm font-medium text-text-primary">
        Outcome
      </label>
      <select id={`${id}-outcome`} name="outcome" required defaultValue="" className={SELECT}>
        <option value="" disabled>
          Choose an outcome
        </option>
        {PLATFORM_CASE_OUTCOMES.map((outcome) => (
          <option key={outcome} value={outcome}>
            {CASE_OUTCOME_LABELS[outcome]}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-note`} className="text-sm font-medium text-text-primary">
        Note
      </label>
      <textarea id={`${id}-note`} name="note" required minLength={10} maxLength={500} className={TEXTAREA} />
      <button type="submit" aria-disabled={pending} aria-busy={pending} className={`${SECONDARY} self-start`}>
        {pending ? "Closing…" : "Close the case"}
      </button>
      <div ref={result} tabIndex={-1} className="focus:outline-none">
        <Refusal outcome={state.outcome} standalone />
      </div>
    </form>
  );
}
