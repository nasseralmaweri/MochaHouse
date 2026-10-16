"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { PlatformTenantLifecycleResponse } from "@mocha-house/contracts";
import { platformSignOutAction } from "@/lib/platform-auth/actions";
import {
  correctOwnerEmailAction,
  reactivateTenantAction,
  suspendTenantAction,
  type LifecycleFormState,
} from "@/lib/platform/tenant-lifecycle-actions";
import {
  LIFECYCLE_MESSAGES,
  SUSPENSION_REASON_OPTIONS,
  describeImpact,
} from "@/lib/platform/tenant-lifecycle";
import { SUSPENSION_REASON_LABELS } from "@/lib/platform/tenant-registry";
import { PlatformCard } from "./PlatformCards";
import { platformInputClassName } from "./PlatformAuthFrame";
import { TenantStatusBadge } from "./TenantRegistry";

// SC1e — a business's lifecycle on its detail page: suspend (reason, impact,
// typed confirmation), reactivate, and correct a never-signed-in first
// owner's email. Every change goes through a server action; the API checks
// the operator, a recent sign-in, and the business's current state.

const INITIAL: LifecycleFormState = { outcome: null, fieldError: null };

// A form is open from the moment it was opened until a NEW successful answer
// arrives (an error keeps it open, with the values typed so far).
function isOpen(
  openedAt: LifecycleFormState | null,
  state: LifecycleFormState,
): boolean {
  if (openedAt === null) return false;
  return openedAt === state || state.outcome?.kind !== "done";
}

// A refused attempt made since the form was opened (an earlier answer is
// never shown again when the form is reopened).
function refusedSince(
  openedAt: LifecycleFormState | null,
  state: LifecycleFormState,
): boolean {
  return (
    openedAt !== null &&
    state !== openedAt &&
    (state.fieldError !== null ||
      (state.outcome !== null && state.outcome.kind !== "done"))
  );
}

const SECONDARY =
  "inline-flex min-h-10 items-center rounded-lg border border-border-default px-3 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const DANGER =
  "inline-flex min-h-10 items-center rounded-lg bg-status-error px-4 text-sm font-semibold text-surface-card hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-disabled:cursor-wait aria-disabled:opacity-70";
const PRIMARY =
  "inline-flex min-h-10 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-contrast hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-disabled:cursor-wait aria-disabled:opacity-70";

// A refused attempt, inside the change's form (a success is announced by a
// persistent status region instead). A recent-sign-in refusal offers signing
// in again (sign out first: the sign-in page sends a signed-in operator
// straight back to the console).
function Outcome({ state }: { state: LifecycleFormState }) {
  const outcome = state.outcome;
  if (state.fieldError) {
    return (
      <p role="alert" className="text-sm text-status-error">
        {state.fieldError}
      </p>
    );
  }
  if (!outcome || outcome.kind === "done") return null;
  if (outcome.kind === "reauth") {
    return (
      <div className="flex flex-col items-start gap-2 rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-text-primary">
        <p role="alert">{LIFECYCLE_MESSAGES.reauth}</p>
        {/* Rendered inside the change's own form: formAction (not a nested
            form) makes this button sign out instead of resubmitting. */}
        <button type="submit" formAction={platformSignOutAction} formNoValidate className={SECONDARY}>
          Sign out and sign in again
        </button>
      </div>
    );
  }
  return (
    <p role="alert" className="rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error">
      {outcome.message}
    </p>
  );
}

type ActionTuple = [
  LifecycleFormState,
  (payload: FormData) => void,
  boolean,
];

// The suspend and reactivate action state lives in the panel: a successful
// change swaps one section for the other, and the panel announces it.
function SuspendSection({
  lifecycle,
  slug,
  action: [state, formAction, pending],
}: {
  lifecycle: PlatformTenantLifecycleResponse;
  slug: string;
  action: ActionTuple;
}) {
  // The answer the form was opened against: a NEW successful answer closes
  // it (derived, not set in an effect); an error keeps it open.
  const [openedAt, setOpenedAt] = useState<LifecycleFormState | null>(null);
  const open = isOpen(openedAt, state);
  // Controlled, so a refused attempt keeps the operator's choices.
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const id = useId();
  const firstReason = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const attempt = useRef<HTMLDivElement>(null);
  const refused = refusedSince(openedAt, state);

  useEffect(() => {
    if (open) firstReason.current?.focus();
  }, [open]);
  // A refused attempt takes focus, so it is heard and can be fixed.
  useEffect(() => {
    if (refused) attempt.current?.focus();
  }, [refused, state]);

  const impact = describeImpact(
    lifecycle.impact.openOrders,
    lifecycle.impact.pendingNotifications,
  );

  return (
    <div className="flex flex-col gap-3">
      {!open ? (
        <button
          ref={toggle}
          type="button"
          onClick={() => {
            setReason("");
            setConfirmation("");
            setOpenedAt(state);
          }}
          className="inline-flex min-h-10 w-fit items-center rounded-lg border border-status-error px-3 text-sm font-semibold text-status-error hover:bg-status-error/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
        >
          Suspend business…
        </button>
      ) : (
        <form
          action={formAction}
          onSubmit={(event) => {
            if (pending) event.preventDefault();
          }}
          className="flex flex-col gap-4 rounded-xl border border-status-error/40 p-4"
          aria-labelledby={`${id}-title`}
        >
          <h3 id={`${id}-title`} className="text-base font-semibold text-text-primary">
            Suspend this business
          </h3>
          <input type="hidden" name="tenantId" value={lifecycle.tenantId} />
          <input type="hidden" name="slug" value={slug} />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-text-primary">Reason</legend>
            {SUSPENSION_REASON_OPTIONS.map((option, index) => (
              <label key={option.value} className="flex items-start gap-2 text-sm text-text-primary">
                <input
                  ref={index === 0 ? firstReason : undefined}
                  type="radio"
                  name="reason"
                  value={option.value}
                  checked={reason === option.value}
                  onChange={() => setReason(option.value)}
                  required
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-text-secondary">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
            <p className="font-medium">While suspended</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-text-secondary">
              {impact.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-confirm`} className="text-sm font-medium text-text-primary">
              Type <span className="font-mono">{slug}</span> to confirm
            </label>
            <input
              id={`${id}-confirm`}
              name="confirmSlug"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
              className={`${platformInputClassName} font-mono`}
            />
          </div>
          <div ref={attempt} tabIndex={-1} className="focus:outline-none">
            {refused ? <Outcome state={state} /> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" aria-disabled={pending} aria-busy={pending} className={DANGER}>
              {pending ? "Suspending…" : "Suspend business"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpenedAt(null);
                requestAnimationFrame(() => toggle.current?.focus());
              }}
              className={SECONDARY}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function ReactivateSection({
  tenantId,
  action: [state, formAction, pending],
}: {
  tenantId: string;
  action: ActionTuple;
}) {
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col items-start gap-3"
    >
      <input type="hidden" name="tenantId" value={tenantId} />
      <p className="text-sm text-text-secondary">
        Reactivating reopens the online store and staff access. Held
        notifications resume; any that went out of date are not sent.
      </p>
      <button type="submit" aria-disabled={pending} aria-busy={pending} className={PRIMARY}>
        {pending ? "Reactivating…" : "Reactivate business"}
      </button>
      <Outcome state={state} />
    </form>
  );
}

function OwnerSection({
  tenantId,
  owner,
}: {
  tenantId: string;
  owner: NonNullable<PlatformTenantLifecycleResponse["owner"]>;
}) {
  const [state, formAction, pending] = useActionState(correctOwnerEmailAction, INITIAL);
  const [openedAt, setOpenedAt] = useState<LifecycleFormState | null>(null);
  const open = isOpen(openedAt, state);
  const [email, setEmail] = useState("");
  const [emailConfirm, setEmailConfirm] = useState("");
  const id = useId();
  const emailInput = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const attempt = useRef<HTMLDivElement>(null);
  const refused = refusedSince(openedAt, state);
  const doneMessage =
    !open && state.outcome?.kind === "done"
      ? state.outcome.changed
        ? "The owner’s email was corrected."
        : "No change: that is already the owner’s email."
      : "";

  useEffect(() => {
    if (open) emailInput.current?.focus();
  }, [open]);
  useEffect(() => {
    if (state.outcome?.kind === "done") toggle.current?.focus();
  }, [state]);
  useEffect(() => {
    if (refused) attempt.current?.focus();
  }, [refused, state]);

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-text-secondary">Email</dt>
        <dd className="break-all text-text-primary">{owner.email}</dd>
        {owner.displayName ? (
          <>
            <dt className="text-text-secondary">Name</dt>
            <dd className="text-text-primary">{owner.displayName}</dd>
          </>
        ) : null}
        <dt className="text-text-secondary">Signed in</dt>
        <dd className="text-text-primary">
          {owner.signedIn ? "Yes" : "Not yet"}
        </dd>
      </dl>
      {owner.signedIn ? (
        <p className="text-sm text-text-secondary">
          The owner has signed in, so their email is now managed by the
          business itself.
        </p>
      ) : !open ? (
        <button
          ref={toggle}
          type="button"
          onClick={() => {
            setEmail("");
            setEmailConfirm("");
            setOpenedAt(state);
          }}
          className={`${SECONDARY} w-fit`}
        >
          Correct owner email…
        </button>
      ) : (
        <form
          action={formAction}
          onSubmit={(event) => {
            if (pending) event.preventDefault();
          }}
          className="flex flex-col gap-3 rounded-xl border border-border-default p-4"
          aria-labelledby={`${id}-title`}
        >
          <h3 id={`${id}-title`} className="text-base font-semibold text-text-primary">
            Correct the owner&rsquo;s email
          </h3>
          <p id={`${id}-hint`} className="text-sm text-text-secondary">
            Only while the owner has never signed in. They must then sign in
            with exactly the new address, once it is verified.
          </p>
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="ownerId" value={owner.id} />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-email`} className="text-sm font-medium text-text-primary">
              New owner email
            </label>
            <input
              ref={emailInput}
              id={`${id}-email`}
              name="email"
              type="email"
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-describedby={`${id}-hint`}
              className={platformInputClassName}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-email-confirm`} className="text-sm font-medium text-text-primary">
              Confirm new owner email
            </label>
            <input
              id={`${id}-email-confirm`}
              name="emailConfirm"
              type="email"
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={254}
              value={emailConfirm}
              onChange={(event) => setEmailConfirm(event.target.value)}
              className={platformInputClassName}
            />
          </div>
          <div ref={attempt} tabIndex={-1} className="focus:outline-none">
            {refused ? <Outcome state={state} /> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" aria-disabled={pending} aria-busy={pending} className={PRIMARY}>
              {pending ? "Saving…" : "Save owner email"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpenedAt(null);
                requestAnimationFrame(() => toggle.current?.focus());
              }}
              className={SECONDARY}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {/* Always mounted, so the result is announced reliably. */}
      <p
        role="status"
        className={
          doneMessage
            ? "rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary"
            : "sr-only"
        }
      >
        {doneMessage}
      </p>
    </div>
  );
}

export function TenantLifecyclePanel({
  lifecycle,
  slug,
}: {
  lifecycle: PlatformTenantLifecycleResponse;
  slug: string;
}) {
  const suspend = useActionState(suspendTenantAction, INITIAL);
  const reactivate = useActionState(reactivateTenantAction, INITIAL);
  const suspendState = suspend[0];
  const reactivateState = reactivate[0];
  const statusMessage = useRef<HTMLParagraphElement>(null);
  // The latest successful status change, announced (and focused) here,
  // because the section that made it is replaced by the other one.
  const message =
    lifecycle.status === "SUSPENDED" && suspendState.outcome?.kind === "done"
      ? suspendState.outcome.changed
        ? "The business is suspended."
        : "No change: the business was already suspended."
      : lifecycle.status === "ACTIVE" && reactivateState.outcome?.kind === "done"
        ? reactivateState.outcome.changed
          ? "The business is active again."
          : "No change: the business was already active."
        : null;
  useEffect(() => {
    if (message) statusMessage.current?.focus();
  }, [message, suspendState, reactivateState]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PlatformCard title="Business status">
        <p
          ref={statusMessage}
          role="status"
          tabIndex={-1}
          className={
            message
              ? "rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary focus:outline-none"
              : "sr-only"
          }
        >
          {message ?? ""}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-text-secondary">Status</dt>
          <dd>
            <TenantStatusBadge status={lifecycle.status} />
          </dd>
          {lifecycle.suspensionReason ? (
            <>
              <dt className="text-text-secondary">Reason</dt>
              <dd className="text-text-primary">
                {SUSPENSION_REASON_LABELS[lifecycle.suspensionReason]}
              </dd>
            </>
          ) : null}
        </dl>
        {lifecycle.status === "SUSPENDED" ? (
          <ReactivateSection tenantId={lifecycle.tenantId} action={reactivate} />
        ) : lifecycle.protected ? (
          <p className="text-sm text-text-secondary">
            This is CENTERIVO&rsquo;s first business (Tenant #1). It cannot be
            suspended from the platform console.
          </p>
        ) : (
          <SuspendSection lifecycle={lifecycle} slug={slug} action={suspend} />
        )}
        <p className="text-xs text-text-secondary">
          Changes need a sign-in within the last 15 minutes and are recorded
          in the platform audit trail.
        </p>
      </PlatformCard>

      <PlatformCard title="First owner">
        {lifecycle.owner ? (
          <OwnerSection tenantId={lifecycle.tenantId} owner={lifecycle.owner} />
        ) : (
          <p className="text-sm text-text-secondary">
            This business has no owner with full administration.
          </p>
        )}
      </PlatformCard>
    </div>
  );
}
