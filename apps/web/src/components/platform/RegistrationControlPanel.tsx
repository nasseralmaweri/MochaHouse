"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { PlatformRegistrationControlView } from "@mocha-house/contracts";
import { platformSignOutAction } from "@/lib/platform-auth/actions";
import {
  changeRegistrationControlAction,
  type ControlFormState,
} from "@/lib/platform/onboarding-actions";
import {
  CONTROL_MESSAGES,
  availabilitySummary,
  formatPlatformTime,
  quotaSummary,
  validReason,
} from "@/lib/platform/onboarding";
import { PlatformCard } from "./PlatformCards";
import { platformInputClassName } from "./PlatformAuthFrame";

// SC4e — new owner registrations: whether they are accepted, the rolling
// 24-hour quota, the pause history, and (onboarding.manage only) pausing or
// resuming them with a written reason. The deployment's own switch is shown,
// never offered: operators cannot turn registration on here.

const INITIAL: ControlFormState = { outcome: null, fieldError: null };

const SECONDARY =
  "inline-flex min-h-10 items-center rounded-lg border border-border-default px-3 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const DANGER =
  "inline-flex min-h-10 items-center rounded-lg bg-status-error px-4 text-sm font-semibold text-surface-card hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-wait disabled:opacity-70";
const PRIMARY =
  "inline-flex min-h-10 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-contrast hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-wait disabled:opacity-70";

const TONE: Record<"positive" | "warning" | "neutral", string> = {
  positive: "bg-status-success/10 text-status-success",
  warning: "bg-status-warning/10 text-status-warning",
  neutral: "bg-surface-subtle text-text-secondary",
};

export function RegistrationControlPanel({
  view,
  canManage,
}: {
  view: PlatformRegistrationControlView;
  canManage: boolean;
}) {
  const summary = availabilitySummary(view);
  return (
    <PlatformCard title="New registrations">
      <div className="flex flex-col gap-1">
        <span className={`self-start rounded-full px-2.5 py-1 text-xs font-medium ${TONE[summary.tone]}`}>
          {summary.title}
        </span>
        <p className="text-sm text-text-secondary">{summary.detail}</p>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
        <dt className="text-text-secondary">Deployment switch</dt>
        <dd className="text-text-primary">
          {view.flag === "ON" ? "On" : view.flag === "OFF" ? "Off" : "On, but incomplete settings (off)"}
        </dd>
        <dt className="text-text-secondary">Emergency pause</dt>
        <dd className="text-text-primary">
          {view.lastChange
            ? `${view.paused ? "Paused" : "Not paused"} since ${formatPlatformTime(view.lastChange.at)} (${view.lastChange.paused ? "paused" : "resumed"} by ${view.lastChange.operatorEmail})`
            : "Not paused"}
        </dd>
        <dt className="text-text-secondary">Daily quota</dt>
        <dd className="text-text-primary">{quotaSummary(view.quota)}</dd>
      </dl>
      {canManage ? (
        <>
          {view.flag !== "ON" ? (
            <p role="note" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
              The deployment switch is off, so pausing or resuming changes nothing for now. It takes
              effect only once the deployment owner turns registration on — and resuming never turns it on.
            </p>
          ) : null}
          <ControlForm paused={view.paused} />
        </>
      ) : (
        <p className="text-xs text-text-muted">
          Pausing or resuming new registrations needs the onboarding.manage permission.
        </p>
      )}
      {view.history.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-text-primary">
            Pause history ({view.history.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {view.history.map((change) => (
              <li key={`${change.at}-${change.operatorEmail}`} className="rounded-lg bg-surface-subtle px-3 py-2">
                <p className="font-medium text-text-primary">
                  {change.paused ? "Paused" : "Resumed"} · {formatPlatformTime(change.at)} · {change.operatorEmail}
                </p>
                <p className="break-words text-text-secondary">{change.reason}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </PlatformCard>
  );
}

function ControlForm({ paused }: { paused: boolean }) {
  // Controlled, so a typed reason survives a refusal (sign-in, rate limit,
  // network) instead of being reset with the form.
  const [reason, setReason] = useState("");
  // Pausing stops sign-ups at once: it asks for a confirmation first.
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(
    async (previous: ControlFormState, form: FormData) => {
      const next = await changeRegistrationControlAction(previous, form);
      if (next.outcome?.kind === "ok") setReason("");
      setConfirming(false);
      return next;
    },
    INITIAL,
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const reasonId = useId();
  const hintId = useId();
  const errorId = useId();
  const message = useRef<HTMLDivElement>(null);
  const outcome = state.outcome;
  const fieldError = localError ?? state.fieldError;

  // After each answer, focus moves to the result so it is read out.
  useEffect(() => {
    if (state !== INITIAL) message.current?.focus();
  }, [state]);

  function askToConfirm() {
    if (!validReason(reason)) {
      setLocalError(CONTROL_MESSAGES.reason);
      document.getElementById(reasonId)?.focus();
      return;
    }
    setLocalError(null);
    setConfirming(true);
  }

  return (
    <form action={formAction} className="flex flex-col gap-3 border-t border-border-default pt-3">
      <input type="hidden" name="paused" value={paused ? "false" : "true"} />
      <label htmlFor={reasonId} className="text-sm font-medium text-text-primary">
        {paused ? "Reason for resuming" : "Reason for pausing"}
      </label>
      <p id={hintId} className="text-xs text-text-muted">
        10–500 characters, kept in the pause history and the audit log.{" "}
        {paused
          ? "Resuming does not turn registration on if the deployment switch is off."
          : "Pausing stops new registrations and new codes; anyone who already has a code can still finish."}
      </p>
      <textarea
        id={reasonId}
        name="reason"
        rows={3}
        required
        minLength={10}
        maxLength={500}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
          setLocalError(null);
          setConfirming(false);
        }}
        aria-describedby={fieldError ? `${hintId} ${errorId}` : hintId}
        aria-invalid={fieldError ? true : undefined}
        className={platformInputClassName}
      />
      {fieldError ? (
        <p id={errorId} role="alert" className="text-sm text-status-error">
          {fieldError}
        </p>
      ) : null}
      <div ref={message} tabIndex={-1} className="outline-none">
        {outcome?.kind === "reauth" ? (
          <div className="flex flex-col items-start gap-2 rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-text-primary">
            <p role="alert">{CONTROL_MESSAGES.reauth}</p>
            <button type="submit" formAction={platformSignOutAction} formNoValidate className={SECONDARY}>
              Sign out and sign in again
            </button>
          </div>
        ) : outcome?.kind === "error" ? (
          <p role="alert" className="rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error">
            {outcome.message}
          </p>
        ) : outcome?.kind === "ok" ? (
          <p role="status" className="text-sm text-status-success">
            {outcome.view.paused ? "New registrations are paused." : "New registrations are no longer paused."}
          </p>
        ) : null}
      </div>
      {!paused && confirming ? (
        <div className="flex flex-col gap-3 rounded-lg border border-status-error/40 bg-status-error/5 px-3 py-3">
          <p className="text-sm text-text-primary">
            Pause new registrations? New sign-ups and new codes stop now. People who already have a code
            can still finish, and existing businesses are not affected.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} aria-busy={pending} className={DANGER}>
              {pending ? "Pausing…" : "Confirm pause"}
            </button>
            <button type="button" disabled={pending} onClick={() => setConfirming(false)} className={SECONDARY}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div>
          {paused ? (
            <button
              type="submit"
              disabled={pending}
              aria-busy={pending}
              onClick={(event) => {
                if (!validReason(reason)) {
                  event.preventDefault();
                  setLocalError(CONTROL_MESSAGES.reason);
                }
              }}
              className={PRIMARY}
            >
              {pending ? "Resuming…" : "Resume new registrations"}
            </button>
          ) : (
            <button type="button" disabled={pending} onClick={askToConfirm} className={DANGER}>
              Pause new registrations
            </button>
          )}
        </div>
      )}
    </form>
  );
}
