"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type {
  OptionalModuleKey,
  PlatformSubscriptionChangeResponse,
  PlatformSubscriptionEventType,
  PlatformSubscriptionPreviewResponse,
  PlatformTenantSubscriptionResponse,
  SubscriptionModuleKey,
} from "@mocha-house/contracts";
import { platformSignOutAction } from "@/lib/platform-auth/actions";
import {
  applySubscriptionAction,
  previewSubscriptionAction,
  type ActionState,
} from "@/lib/platform/subscription-actions";
import {
  SUBSCRIPTION_MESSAGES,
  VERSION_STATUS_LABELS,
  addOnCandidates,
  moduleLabel,
  type ChangeOutcome,
} from "@/lib/platform/subscriptions";
import { formatRegistryDate } from "@/lib/platform/tenant-registry";
import { PlatformCard } from "./PlatformCards";

// SC2a — a business's subscription on its detail page: plan and version,
// effective modules, add-ons, recent history; change the plan or an add-on
// in two steps — PREVIEW (what it gains and loses; nothing changes) then
// CONFIRM. A change never deletes data; open orders, refunds and stored
// gift-card / loyalty balances stay manageable.

type Change = { kind: "plan" | "grant" | "revoke"; value: string; label: string };

const SECONDARY =
  "inline-flex min-h-10 items-center rounded-lg border border-border-default px-3 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const PRIMARY =
  "inline-flex min-h-10 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-contrast hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-disabled:cursor-wait aria-disabled:opacity-70";
const SELECT =
  "min-h-10 rounded-lg border border-border-default bg-surface-card px-3 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

const EVENT_LABELS: Record<PlatformSubscriptionEventType, string> = {
  PLAN_ASSIGNED: "Plan assigned",
  PLAN_CHANGED: "Plan changed",
  ADDON_GRANTED: "Add-on granted",
  ADDON_REVOKED: "Add-on revoked",
  // SC3a — billing lifecycle (recorded once billing is active).
  TRIAL_STARTED: "Trial started",
  PAYMENT_AUTHORIZED: "Automatic payment authorized",
  PAYMENT_SUCCEEDED: "Payment received",
  PAYMENT_FAILED: "Payment failed",
  GRACE_EXPIRED: "Grace period ended",
  TRIAL_EXPIRED: "Trial ended without payment",
  CANCEL_SCHEDULED: "Cancellation scheduled",
  CANCEL_UNDONE: "Cancellation withdrawn",
  CANCELED: "Subscription ended",
  PLAN_CHANGE_PENDING: "Plan change pending",
  PLAN_CHANGE_APPLIED: "Plan change applied",
  PLAN_CHANGE_ABANDONED: "Plan change not completed",
};

function Chips({ modules }: { modules: readonly SubscriptionModuleKey[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {modules.map((key) => (
        <li key={key} className="rounded-full border border-border-default px-2.5 py-0.5 text-xs text-text-primary">
          {moduleLabel(key)}
        </li>
      ))}
    </ul>
  );
}

// `standalone`: rendered outside any form, so the sign-out button brings its
// own form (inside a form it uses formAction instead — forms cannot nest).
function Refusal<T>({
  outcome,
  standalone = false,
}: {
  outcome: ChangeOutcome<T> | null;
  standalone?: boolean;
}) {
  if (!outcome || outcome.kind === "ok") return null;
  if (outcome.kind === "reauth") {
    const button = standalone ? (
      <form action={platformSignOutAction}>
        <button type="submit" className={SECONDARY}>
          Sign out and sign in again
        </button>
      </form>
    ) : (
      <button type="submit" formAction={platformSignOutAction} formNoValidate className={SECONDARY}>
        Sign out and sign in again
      </button>
    );
    return (
      <div className="flex flex-col items-start gap-2 rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-text-primary">
        <p role="alert">{SUBSCRIPTION_MESSAGES.reauth}</p>
        {button}
      </div>
    );
  }
  return (
    <p role="alert" className="rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error">
      {outcome.message}
    </p>
  );
}

export function SubscriptionPanel({
  data,
  versions,
}: {
  data: PlatformTenantSubscriptionResponse;
  versions: Array<{ id: string; label: string }>;
}) {
  const [preview, previewAction, previewing] = useActionState(
    previewSubscriptionAction,
    { outcome: null } as ActionState<PlatformSubscriptionPreviewResponse>,
  );
  const [applied, applyAction, applying] = useActionState(
    applySubscriptionAction,
    { outcome: null } as ActionState<PlatformSubscriptionChangeResponse>,
  );
  // The change being previewed, and the preview answer it belongs to.
  const [pending, setPending] = useState<{
    change: Change;
    at: typeof preview;
    appliedAt: typeof applied;
  } | null>(null);
  const [planChoice, setPlanChoice] = useState("");
  const [addOnChoice, setAddOnChoice] = useState("");
  const id = useId();
  const status = useRef<HTMLParagraphElement>(null);
  const summary = useRef<HTMLDivElement>(null);

  const sub = data.subscription;
  const candidates = addOnCandidates(data.modules);
  // A choice that has since become current (or available) reads as empty
  // again, so the panel stays mounted (and its result announced) after a
  // change.
  const planValue = planChoice === sub?.version.id ? "" : planChoice;
  const addOnValue = candidates.includes(addOnChoice as OptionalModuleKey) ? addOnChoice : "";
  // A preview answered since it was started, not yet confirmed successfully.
  const showPreview =
    pending !== null &&
    preview !== pending.at &&
    preview.outcome?.kind === "ok" &&
    !(applied !== pending.appliedAt && applied.outcome?.kind === "ok");
  const appliedMessage =
    applied.outcome?.kind === "ok"
      ? applied.outcome.data.changed
        ? "The subscription was updated."
        : "No change: the subscription already matched."
      : "";

  useEffect(() => {
    if (showPreview) summary.current?.focus();
  }, [showPreview, preview]);
  useEffect(() => {
    if (appliedMessage) status.current?.focus();
  }, [appliedMessage, applied]);

  const startPreview = (change: Change) =>
    setPending({ change, at: preview, appliedAt: applied });

  return (
    <PlatformCard title="Subscription">
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className={appliedMessage ? "rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary focus:outline-none" : "sr-only"}
      >
        {appliedMessage}
      </p>

      {sub ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-text-secondary">Plan</dt>
          <dd className="text-text-primary">
            {sub.plan.name} v{sub.version.version}{" "}
            <span className="text-xs text-text-secondary">({VERSION_STATUS_LABELS[sub.version.status]})</span>
          </dd>
          <dt className="text-text-secondary">Since</dt>
          <dd className="text-text-primary">{formatRegistryDate(sub.startedAt)}</dd>
          <dt className="text-text-secondary">Add-ons</dt>
          <dd className="text-text-primary">
            {sub.addOns.length === 0 ? "None" : sub.addOns.map((key) => moduleLabel(key)).join(", ")}
          </dd>
        </dl>
      ) : (
        <p className="rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-text-primary">
          No subscription: this business has <strong>Core only</strong>. Assign a plan below.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-text-primary">Modules available now</p>
        <Chips modules={data.modules} />
      </div>

      {/* Step 1 — choose and preview. */}
      <form
        action={previewAction}
        onSubmit={(event) => {
          if (previewing) event.preventDefault();
        }}
        className="flex flex-col gap-3"
        aria-label="Preview a subscription change"
      >
        <input type="hidden" name="tenantId" value={data.tenantId} />
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:gap-2">
          <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium text-text-primary">
            {sub ? "Change plan to" : "Assign plan"}
            <select value={planValue} onChange={(event) => setPlanChoice(event.target.value)} className={SELECT}>
              <option value="">Choose a published plan…</option>
              {versions.map((version) => (
                <option key={version.id} value={version.id} disabled={version.id === sub?.version.id}>
                  {version.label}
                  {version.id === sub?.version.id ? " (current)" : ""}
                </option>
              ))}
            </select>
          </label>
          <input type="hidden" name="change" value="plan" disabled={!planValue} />
          <input type="hidden" name="value" value={planValue} disabled={!planValue} />
          <button
            type="submit"
            disabled={!planValue}
            onClick={() => startPreview({ kind: "plan", value: planValue, label: versions.find((v) => v.id === planValue)?.label ?? "" })}
            className={SECONDARY}
          >
            Preview change
          </button>
        </div>
      </form>

      {sub ? (
        <form
          action={previewAction}
          onSubmit={(event) => {
            if (previewing) event.preventDefault();
          }}
          className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:gap-2"
          aria-label="Preview granting an add-on"
        >
          <input type="hidden" name="tenantId" value={data.tenantId} />
          <input type="hidden" name="change" value="grant" />
          <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium text-text-primary">
            Grant an add-on
            <select name="value" value={addOnValue} onChange={(event) => setAddOnChoice(event.target.value)} className={SELECT}>
              <option value="">Choose a module…</option>
              {candidates.map((key) => (
                <option key={key} value={key}>
                  {moduleLabel(key)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={!addOnValue}
            onClick={() => startPreview({ kind: "grant", value: addOnValue, label: `Grant ${moduleLabel(addOnValue as OptionalModuleKey)}` })}
            className={SECONDARY}
          >
            Preview add-on
          </button>
        </form>
      ) : null}

      {sub && sub.addOns.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {sub.addOns.map((key) => (
            <form key={key} action={previewAction}>
              <input type="hidden" name="tenantId" value={data.tenantId} />
              <input type="hidden" name="change" value="revoke" />
              <input type="hidden" name="value" value={key} />
              <button
                type="submit"
                onClick={() => startPreview({ kind: "revoke", value: key, label: `Revoke ${moduleLabel(key)}` })}
                className={SECONDARY}
              >
                Preview revoking {moduleLabel(key)}
              </button>
            </form>
          ))}
        </div>
      ) : null}

      {pending && preview !== pending.at ? <Refusal outcome={preview.outcome} standalone /> : null}

      {/* Step 2 — confirm what the preview showed. */}
      {showPreview && pending && preview.outcome?.kind === "ok" ? (
        <div
          ref={summary}
          tabIndex={-1}
          role="region"
          aria-labelledby={`${id}-preview`}
          className="flex flex-col gap-3 rounded-xl border border-border-default p-4 focus:outline-none"
        >
          <h3 id={`${id}-preview`} className="text-base font-semibold text-text-primary">
            {pending.change.kind === "plan" ? `Change to ${pending.change.label}` : pending.change.label}
          </h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-text-secondary">Gains</dt>
            <dd>{preview.outcome.data.gained.length === 0 ? "Nothing" : <Chips modules={preview.outcome.data.gained} />}</dd>
            <dt className="text-text-secondary">Loses</dt>
            <dd>{preview.outcome.data.lost.length === 0 ? "Nothing" : <Chips modules={preview.outcome.data.lost} />}</dd>
            <dt className="text-text-secondary">Afterwards</dt>
            <dd><Chips modules={preview.outcome.data.proposed} /></dd>
          </dl>
          {preview.outcome.data.lost.length > 0 ? (
            <p className="text-sm text-text-secondary">
              Lost modules close to new activity immediately. No data is deleted; open orders, refunds, and
              existing gift-card and loyalty balances stay manageable.
            </p>
          ) : null}
          <form
            action={applyAction}
            onSubmit={(event) => {
              if (applying) event.preventDefault();
            }}
            className="flex flex-col gap-2"
          >
            <input type="hidden" name="tenantId" value={data.tenantId} />
            <input type="hidden" name="change" value={pending.change.kind} />
            <input type="hidden" name="value" value={pending.change.value} />
            <Refusal outcome={applied.outcome} />
            <div className="flex flex-wrap gap-2">
              <button type="submit" aria-disabled={applying} aria-busy={applying} className={PRIMARY}>
                {applying ? "Applying…" : "Confirm change"}
              </button>
              <button type="button" onClick={() => setPending(null)} className={SECONDARY}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {data.history.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-text-primary">History</summary>
          <ul className="mt-2 flex flex-col gap-1 text-text-secondary">
            {data.history.map((event, index) => (
              <li key={`${event.at}-${index}`}>
                {formatRegistryDate(event.at)} — {EVENT_LABELS[event.type]}
                {event.toVersion ? `: ${event.fromVersion ? `${event.fromVersion} → ` : ""}${event.toVersion}` : ""}
                {event.moduleKey ? `: ${moduleLabel(event.moduleKey)}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </PlatformCard>
  );
}
