"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { PlatformStorefrontView } from "@mocha-house/contracts";
import { platformSignOutAction } from "@/lib/platform-auth/actions";
import {
  storefrontAction,
  type StorefrontFormState,
} from "@/lib/platform/storefront-actions";
import {
  ACTION_LABEL,
  CHECK_LABEL,
  KIND_LABEL,
  PLATFORM_UNAVAILABLE_LABEL,
  STOREFRONT_MESSAGES,
  liveSummary,
  validReason,
} from "@/lib/platform/storefront";
import { formatPlatformTime } from "@/lib/platform/onboarding";
import { PlatformCard } from "./PlatformCards";
import { platformInputClassName } from "./PlatformAuthFrame";

// SC4f-3a — one business's storefront in the Platform Console: whether host
// routing is on (registry publication is not the same as being live), its
// approved addresses with publish / unpublish, the publishing checks,
// assigning an address, and the history. Every change asks for a reason and
// the business's slug; the API decides.

const INITIAL: StorefrontFormState = { outcome: null, fieldError: null };

const SECONDARY =
  "inline-flex min-h-10 items-center rounded-lg border border-border-default px-3 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const PRIMARY =
  "inline-flex min-h-10 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-contrast hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-wait disabled:opacity-70";
const DANGER =
  "inline-flex min-h-10 items-center rounded-lg bg-status-error px-4 text-sm font-semibold text-surface-card hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-wait disabled:opacity-70";

export function StorefrontPanel({ view }: { view: PlatformStorefrontView }) {
  const { tenant, hostRouting, hosts, eligibility, assignable, history } = view;
  return (
    <div className="flex flex-col gap-4">
      <PlatformCard title="Public availability">
        <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-text-secondary">Business</dt>
          <dd className="text-text-primary">
            {tenant.name} <span className="font-mono text-text-secondary">({tenant.slug})</span>
            {tenant.status !== "ACTIVE" ? " · Suspended" : ""}
          </dd>
          <dt className="text-text-secondary">Host routing</dt>
          <dd className="text-text-primary">{hostRouting ? "On" : "Off"}</dd>
        </dl>
        {!hostRouting ? (
          <p role="note" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
            Host routing is off for this deployment, so no storefront address is publicly live —
            published here or not. Publishing only records approval in the registry; turning routing
            on is a separate deployment decision.
          </p>
        ) : null}
      </PlatformCard>

      <PlatformCard title="Addresses">
        {hosts.length === 0 ? (
          <p className="text-sm text-text-secondary">No address is assigned to this business yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {hosts.map((host) => (
              <li key={host.id} className="flex flex-col gap-2 rounded-lg border border-border-default px-3 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="break-all font-mono text-sm text-text-primary">{host.hostname}</span>
                  <span className="text-xs text-text-secondary">{KIND_LABEL[host.kind]}</span>
                </div>
                <p className="text-sm text-text-secondary">
                  {liveSummary(host, hostRouting)}
                  {host.published && host.publishedAt ? ` · since ${formatPlatformTime(host.publishedAt)}` : ""}
                </p>
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-text-primary">
                    {host.published ? "Unpublish this address" : "Publish this address"}
                  </summary>
                  <StorefrontActionForm
                    tenantId={tenant.id}
                    intent={host.published ? "unpublish" : "publish"}
                    hostId={host.id}
                    submitLabel={host.published ? "Unpublish" : "Publish"}
                    danger={host.published}
                    hint={
                      host.published
                        ? "Unpublishing takes the address out of service at once whenever host routing is on."
                        : eligibility.eligible
                          ? "The checks below are met. Publishing does not make the storefront public while host routing is off."
                          : "The checks below are not all met yet, so publishing will be refused."
                    }
                  />
                </details>
              </li>
            ))}
          </ul>
        )}
      </PlatformCard>

      <PlatformCard title="Publishing checks">
        <ul className="flex flex-col gap-1 text-sm">
          {eligibility.checks.map((check) => (
            <li key={check.key} className="flex gap-2">
              <span aria-hidden className={check.passed ? "text-status-success" : "text-status-error"}>
                {check.passed ? "✓" : "✗"}
              </span>
              <span className="text-text-primary">
                {CHECK_LABEL[check.key]}
                <span className="sr-only">{check.passed ? " — met" : " — not met"}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-text-muted">
          Online ordering does not need to be on: a published storefront may be browse-only. A
          published storefront is never unpublished automatically; suspension and billing rules still
          apply to it while it runs.
        </p>
      </PlatformCard>

      <PlatformCard title="Assign an address">
        {assignable.platformHostname ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-text-primary">
              Platform address: <span className="break-all font-mono">{assignable.platformHostname}</span>
            </p>
            <StorefrontActionForm
              tenantId={tenant.id}
              intent="assign-platform"
              submitLabel="Assign platform address"
              hint="Assigned addresses start unpublished and can never move to another business."
            />
          </div>
        ) : (
          <p className="text-sm text-text-secondary">
            {assignable.platformUnavailable
              ? PLATFORM_UNAVAILABLE_LABEL[assignable.platformUnavailable]
              : "No platform address can be assigned."}
          </p>
        )}
        {assignable.legacyHostnames.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-border-default pt-3">
            <p className="text-sm text-text-primary">Approved existing Mocha House addresses</p>
            <StorefrontActionForm
              tenantId={tenant.id}
              intent="assign-legacy"
              legacyHostnames={assignable.legacyHostnames}
              submitLabel="Register existing address"
              hint="Only addresses approved in this deployment's configuration can be registered, and only for Mocha House."
            />
          </div>
        ) : null}
      </PlatformCard>

      {history.length > 0 ? (
        <PlatformCard title={`History (${history.length})`}>
          <ul className="flex flex-col gap-2 text-sm">
            {history.map((entry) => (
              <li key={entry.id} className="rounded-lg bg-surface-subtle px-3 py-2">
                <p className="font-medium text-text-primary">
                  {ACTION_LABEL[entry.action]} · <span className="break-all font-mono">{entry.hostname}</span> ·{" "}
                  {formatPlatformTime(entry.createdAt)} · {entry.actorEmail}
                </p>
                <p className="break-words text-text-secondary">{entry.reason}</p>
              </li>
            ))}
          </ul>
        </PlatformCard>
      ) : null}
    </div>
  );
}

function StorefrontActionForm({
  tenantId,
  intent,
  hostId,
  legacyHostnames,
  submitLabel,
  hint,
  danger = false,
}: {
  tenantId: string;
  intent: "assign-platform" | "assign-legacy" | "publish" | "unpublish";
  hostId?: string;
  legacyHostnames?: string[];
  submitLabel: string;
  hint: string;
  danger?: boolean;
}) {
  // Controlled, so typed values survive a refusal (sign-in, rate limit,
  // network) instead of being reset with the form.
  const [reason, setReason] = useState("");
  const [slug, setSlug] = useState("");
  // Unpublishing takes an address out of service: it needs an explicit
  // confirmation as well as the reason and slug.
  const [confirmed, setConfirmed] = useState(false);
  const [state, formAction, pending] = useActionState(
    async (previous: StorefrontFormState, form: FormData) => {
      const next = await storefrontAction(previous, form);
      if (next.outcome?.kind === "ok") {
        setReason("");
        setSlug("");
        setConfirmed(false);
      }
      return next;
    },
    INITIAL,
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const confirmId = useId();
  const reasonId = useId();
  const slugId = useId();
  const hostnameId = useId();
  const hintId = useId();
  const errorId = useId();
  const message = useRef<HTMLDivElement>(null);
  const outcome = state.outcome;
  const fieldError = localError ?? state.fieldError;

  // After each answer, focus moves to the result so it is read out; a field
  // the server refused gets the focus instead, so it can be fixed.
  useEffect(() => {
    if (state === INITIAL) return;
    if (state.outcome) message.current?.focus();
    else if (state.fieldError) reasonRef.current?.focus();
  }, [state]);

  function refuse(error: string, field: { current: HTMLElement | null }) {
    setLocalError(error);
    field.current?.focus();
  }

  return (
    <form action={formAction} className="mt-2 flex flex-col gap-3">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="intent" value={intent} />
      {hostId ? <input type="hidden" name="hostId" value={hostId} /> : null}
      <p id={hintId} className="text-xs text-text-muted">
        {hint} The reason (10–500 characters) is kept in the history and the audit log.
      </p>
      {legacyHostnames ? (
        <>
          <label htmlFor={hostnameId} className="text-sm font-medium text-text-primary">
            Address
          </label>
          <select id={hostnameId} name="hostname" required className={platformInputClassName}>
            {legacyHostnames.map((hostname) => (
              <option key={hostname} value={hostname}>
                {hostname}
              </option>
            ))}
          </select>
        </>
      ) : null}
      <label htmlFor={reasonId} className="text-sm font-medium text-text-primary">
        Reason
      </label>
      <textarea
        ref={reasonRef}
        id={reasonId}
        name="reason"
        rows={2}
        required
        minLength={10}
        maxLength={500}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
          setLocalError(null);
        }}
        aria-describedby={fieldError ? `${hintId} ${errorId}` : hintId}
        aria-invalid={fieldError ? true : undefined}
        className={platformInputClassName}
      />
      <label htmlFor={slugId} className="text-sm font-medium text-text-primary">
        Type the business&apos;s slug to confirm
      </label>
      <input
        ref={slugRef}
        id={slugId}
        name="confirmSlug"
        required
        autoComplete="off"
        spellCheck={false}
        value={slug}
        onChange={(event) => {
          setSlug(event.target.value);
          setLocalError(null);
        }}
        className={`${platformInputClassName} font-mono`}
      />
      {intent === "unpublish" ? (
        <label htmlFor={confirmId} className="flex items-start gap-2 text-sm text-text-primary">
          <input
            ref={confirmRef}
            id={confirmId}
            type="checkbox"
            checked={confirmed}
            onChange={(event) => {
              setConfirmed(event.target.checked);
              setLocalError(null);
            }}
            className="mt-1 h-4 w-4"
          />
          I understand this takes the address out of service whenever host routing is on.
        </label>
      ) : null}
      {fieldError ? (
        <p id={errorId} role="alert" className="text-sm text-status-error">
          {fieldError}
        </p>
      ) : null}
      <div ref={message} tabIndex={-1} className="outline-none">
        {outcome?.kind === "reauth" ? (
          <div className="flex flex-col items-start gap-2 rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-text-primary">
            <p role="alert">{STOREFRONT_MESSAGES.reauth}</p>
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
            Saved.
          </p>
        ) : null}
      </div>
      <div>
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          onClick={(event) => {
            if (!validReason(reason)) {
              event.preventDefault();
              refuse(STOREFRONT_MESSAGES.reason, reasonRef);
            } else if (slug.trim() === "") {
              event.preventDefault();
              refuse(STOREFRONT_MESSAGES.slug, slugRef);
            } else if (intent === "unpublish" && !confirmed) {
              event.preventDefault();
              refuse(STOREFRONT_MESSAGES.confirmUnpublish, confirmRef);
            }
          }}
          className={danger ? DANGER : PRIMARY}
        >
          {pending ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
