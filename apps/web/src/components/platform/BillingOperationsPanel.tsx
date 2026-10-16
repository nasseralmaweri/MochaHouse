"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type {
  BillingRecipientIneligibility,
  PlatformTenantBillingResponse,
} from "@mocha-house/contracts";
import {
  assignBillingContactAction,
  extendGraceAction,
  type BillingActionState,
} from "@/lib/platform/billing-actions";
import { PRIMARY, Refusal, SECONDARY, SELECT } from "./SubscriptionPanel";

const INITIAL: BillingActionState<PlatformTenantBillingResponse> = { outcome: null };

const INELIGIBLE: Record<BillingRecipientIneligibility, string> = {
  NOT_ACTIVE: "not active",
  NO_BILLING_MANAGE: "can't manage billing",
  EMAIL_NOT_VERIFIED: "email not verified yet (receives billing email after they sign in)",
  EMAIL_VERIFICATION_STALE: "email not verified recently (receives billing email after they sign in)",
};

// UTC, stated: the same instant on the server and in every operator's
// browser, and the same zone the owner's Billing page uses.
function when(iso: string | null | undefined): string {
  return iso
    ? `${new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`
    : "—";
}

function person(member: { email: string; displayName: string | null }): string {
  return member.displayName ? `${member.displayName} (${member.email})` : member.email;
}

// SC3c-3 — who receives CENTERIVO billing email for this business, and
// operator grace extensions (PAST_DUE) / exceptions (UNPAID). Both need a
// recent sign-in and are audited. More time never marks anything as paid.
export function BillingOperationsPanel({
  tenantId,
  view,
}: {
  tenantId: string;
  view: PlatformTenantBillingResponse;
}) {
  const [contactState, contactAction, contactPending] = useActionState(
    assignBillingContactAction,
    INITIAL,
  );
  const [days, setDays] = useState(7);
  const [reason, setReason] = useState("");
  const [reviewing, setReviewing] = useState(false);
  // A saved extension clears the form (done with the result, not in an
  // effect).
  const [graceState, graceAction, gracePending] = useActionState(
    async (
      previous: BillingActionState<PlatformTenantBillingResponse>,
      form: FormData,
    ) => {
      const next = await extendGraceAction(previous, form);
      if (next.outcome?.kind === "ok") {
        setReviewing(false);
        setReason("");
      }
      return next;
    },
    INITIAL,
  );
  const current =
    graceState.outcome?.kind === "ok"
      ? graceState.outcome.data
      : contactState.outcome?.kind === "ok"
        ? contactState.outcome.data
        : view;
  const { contact, extensions, extensionDaysRemaining } = current;
  const billing = current.billing;
  const id = useId();
  const [contactId, setContactId] = useState(
    contact.designated?.internalUserId ?? contact.candidates[0]?.internalUserId ?? "",
  );
  const contactResult = useRef<HTMLDivElement>(null);
  const graceResult = useRef<HTMLDivElement>(null);
  const confirmRegion = useRef<HTMLDivElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (contactState.outcome) contactResult.current?.focus();
  }, [contactState]);
  useEffect(() => {
    if (graceState.outcome) graceResult.current?.focus();
  }, [graceState]);
  useEffect(() => {
    if (reviewing) confirmRegion.current?.focus();
    else if (returnFocus.current) reviewButton.current?.focus();
    returnFocus.current = false;
  }, [reviewing]);

  const unpaid = billing?.state === "PAST_DUE" || billing?.state === "UNPAID";
  const deadline =
    billing?.state === "PAST_DUE" ? billing.graceEndsAt : billing?.graceExceptionEndsAt ?? null;
  const maxDays = Math.min(14, extensionDaysRemaining ?? 0);
  const reasonOk = reason.trim().length >= 10 && reason.trim().length <= 500;

  return (
    <div className="flex flex-col gap-6 rounded-2xl border border-border-default bg-surface-card p-5">
      <section aria-labelledby={`${id}-contact`} className="flex flex-col gap-3">
        <h3 id={`${id}-contact`} className="text-base font-semibold text-text-primary">
          Billing contact
        </h3>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-text-secondary">Designated</dt>
            <dd className="break-words font-medium text-text-primary">
              {contact.designated ? person(contact.designated) : "None"}
              {contact.designated?.ineligibleReason ? (
                <span className="block text-xs font-normal text-status-warning">
                  Not eligible now: {INELIGIBLE[contact.designated.ineligibleReason]}
                </span>
              ) : null}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-secondary">Billing email goes to</dt>
            <dd className="break-words font-medium text-text-primary">
              {contact.recipient ? (
                <>
                  {person(contact.recipient)}
                  {contact.recipient.source === "FALLBACK_ADMINISTRATOR" ? (
                    <span className="block text-xs font-normal text-text-secondary">
                      Fallback: earliest eligible administrator
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-status-error">
                  No one eligible. Billing email won&apos;t be sent and a case is opened.
                </span>
              )}
            </dd>
          </div>
        </dl>
        <div ref={contactResult} tabIndex={-1} className="focus:outline-none">
          {contactState.outcome?.kind === "ok" ? (
            <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
              Billing contact saved.
            </p>
          ) : (
            <Refusal outcome={contactState.outcome} standalone />
          )}
        </div>
        {contact.candidates.length === 0 ? (
          <p className="text-sm text-text-secondary">
            No active staff member of this business can manage billing.
          </p>
        ) : (
          <form
            action={contactAction}
            onSubmit={(event) => {
              if (contactPending) event.preventDefault();
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <input type="hidden" name="tenantId" value={tenantId} />
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={`${id}-who`} className="text-sm font-medium text-text-primary">
                Designate
              </label>
              <select
                id={`${id}-who`}
                name="internalUserId"
                value={contactId}
                onChange={(event) => setContactId(event.target.value)}
                className={`${SELECT} max-w-full`}
              >
                {contact.candidates.map((member) => (
                  <option key={member.internalUserId} value={member.internalUserId}>
                    {person(member)}
                    {member.ineligibleReason ? ` — ${INELIGIBLE[member.ineligibleReason]}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              aria-disabled={contactPending}
              aria-busy={contactPending}
              className={SECONDARY}
            >
              {contactPending ? "Saving…" : "Save contact"}
            </button>
          </form>
        )}
      </section>

      <section aria-labelledby={`${id}-grace`} className="flex flex-col gap-3">
        <h3 id={`${id}-grace`} className="text-base font-semibold text-text-primary">
          More time to pay
        </h3>
        {unpaid ? (
          <p className="text-sm text-text-secondary">
            {billing?.state === "PAST_DUE"
              ? `Grace period ends ${when(billing.graceEndsAt)}.`
              : deadline
                ? `Unpaid. Temporary access until ${when(deadline)}.`
                : "Unpaid. Access is limited to billing."}{" "}
            {extensionDaysRemaining !== null
              ? `${extensionDaysRemaining} of 60 days left for this unpaid period.`
              : null}
          </p>
        ) : (
          <p className="text-sm text-text-secondary">
            Only a business with an unpaid invoice can be given more time.
          </p>
        )}
        <div ref={graceResult} tabIndex={-1} className="focus:outline-none">
          {graceState.outcome?.kind === "ok" ? (
            <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
              More time given. The invoice is still unpaid and nothing was charged.
            </p>
          ) : (
            <Refusal outcome={graceState.outcome} standalone />
          )}
        </div>
        {unpaid && maxDays > 0 ? (
          <form
            action={graceAction}
            onSubmit={(event) => {
              if (gracePending) event.preventDefault();
            }}
            className="flex flex-col gap-3"
          >
            <input type="hidden" name="tenantId" value={tenantId} />
            <input type="hidden" name="days" value={days} />
            <input type="hidden" name="reason" value={reason} />
            {!reviewing ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-days`} className="text-sm font-medium text-text-primary">
                    Days
                  </label>
                  <select
                    id={`${id}-days`}
                    value={Math.min(days, maxDays)}
                    onChange={(event) => setDays(Number(event.target.value))}
                    className={`${SELECT} w-32`}
                  >
                    {Array.from({ length: maxDays }, (_, index) => index + 1).map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-reason`} className="text-sm font-medium text-text-primary">
                    Reason
                  </label>
                  <textarea
                    id={`${id}-reason`}
                    value={reason}
                    maxLength={500}
                    rows={3}
                    aria-describedby={`${id}-reason-help`}
                    onChange={(event) => setReason(event.target.value)}
                    className="rounded-lg border border-border-default bg-surface-card px-3 py-2 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                  />
                  <p id={`${id}-reason-help`} className="text-xs text-text-secondary">
                    Required, 10 to 500 characters. Recorded in the business&apos;s billing history.
                  </p>
                </div>
                <div>
                  <button
                    ref={reviewButton}
                    type="button"
                    disabled={!reasonOk}
                    onClick={() => {
                      setDays(Math.min(days, maxDays));
                      setReviewing(true);
                    }}
                    className={`${SECONDARY} disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    Review
                  </button>
                </div>
              </>
            ) : (
              <div
                ref={confirmRegion}
                tabIndex={-1}
                role="group"
                aria-label="Confirm more time to pay"
                className="flex flex-col gap-2 rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary focus:outline-none"
              >
                <p>
                  {billing?.state === "PAST_DUE" ? (
                    <>Extend the grace period by <strong>{days} day{days === 1 ? "" : "s"}</strong>?</>
                  ) : (
                    <>
                      Give <strong>{days} day{days === 1 ? "" : "s"}</strong> of temporary access while
                      unpaid?
                    </>
                  )}{" "}
                  The invoice stays unpaid and nothing is charged. A security or administrative
                  suspension is never lifted.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="submit" aria-disabled={gracePending} aria-busy={gracePending} className={PRIMARY}>
                    {gracePending ? "Saving…" : "Give more time"}
                  </button>
                  <button
                    type="button"
                    disabled={gracePending}
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
        ) : unpaid && extensionDaysRemaining === 0 ? (
          <p className="text-sm text-text-secondary">
            The 60-day limit for this unpaid period has been reached.
          </p>
        ) : unpaid ? (
          <p className="text-sm text-text-secondary">
            More time can&apos;t be given right now. Reload to see this business&apos;s current billing.
          </p>
        ) : null}
        {extensions.length > 0 ? (
          <ul className="flex flex-col gap-2 text-sm">
            {extensions.map((item) => (
              <li key={item.id} className="rounded-lg border border-border-default px-3 py-2">
                <p className="font-medium text-text-primary">
                  {item.kind === "GRACE_EXTENDED" ? "Grace extended" : "Grace exception"} by {item.days}{" "}
                  day{item.days === 1 ? "" : "s"}: {when(item.previousEndsAt)} → {when(item.newEndsAt)}
                </p>
                <p className="break-words text-text-secondary">{item.reason}</p>
                <p className="text-xs text-text-secondary">{when(item.createdAt)}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
