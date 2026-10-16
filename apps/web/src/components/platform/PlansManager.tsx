"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import {
  OPTIONAL_MODULE_KEYS,
  type OptionalModuleKey,
  type PlatformPlan,
  type PlatformPlanVersion,
} from "@mocha-house/contracts";
import { platformSignOutAction } from "@/lib/platform-auth/actions";
import {
  createPlanAction,
  planVersionAction,
  type ActionState,
} from "@/lib/platform/subscription-actions";
import {
  SUBSCRIPTION_MESSAGES,
  VERSION_STATUS_LABELS,
  moduleDescription,
  moduleLabel,
} from "@/lib/platform/subscriptions";
import { platformInputClassName } from "./PlatformAuthFrame";

// SC2a — CENTERIVO plans: create a plan (its version 1 starts as a draft),
// edit a draft's modules, publish it (then it is frozen), start a new
// version, retire a published one. Every change needs a recent sign-in and
// is audited by the API.

const INITIAL: ActionState<PlatformPlan> = { outcome: null };
const SECONDARY =
  "inline-flex min-h-10 items-center rounded-lg border border-border-default px-3 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const PRIMARY =
  "inline-flex min-h-10 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-contrast hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-disabled:cursor-wait aria-disabled:opacity-70";

export function ModuleChips({ keys }: { keys: readonly OptionalModuleKey[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Modules">
      <li className="rounded-full border border-border-default bg-surface-subtle px-2.5 py-0.5 text-xs font-medium text-text-primary">
        Core
      </li>
      {keys.map((key) => (
        <li key={key} className="rounded-full border border-border-default px-2.5 py-0.5 text-xs text-text-primary">
          {moduleLabel(key)}
        </li>
      ))}
    </ul>
  );
}

function ModuleCheckboxes({ selected, legend }: { selected: readonly OptionalModuleKey[]; legend: string }) {
  const [chosen, setChosen] = useState<OptionalModuleKey[]>([...selected]);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-text-primary">{legend}</legend>
      <p className="text-xs text-text-secondary">Core is always included.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {OPTIONAL_MODULE_KEYS.map((key) => (
          <label key={key} className="flex items-start gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              name="moduleKeys"
              value={key}
              checked={chosen.includes(key)}
              onChange={(event) =>
                setChosen((current) =>
                  event.target.checked ? [...current, key] : current.filter((k) => k !== key),
                )
              }
              className="mt-1"
            />
            <span>
              <span className="font-medium">{moduleLabel(key)}</span>
              <span className="block text-xs text-text-secondary">{moduleDescription(key)}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Outcome({ state }: { state: ActionState<PlatformPlan> }) {
  const outcome = state.outcome;
  if (!outcome || outcome.kind === "ok") return null;
  if (outcome.kind === "reauth") {
    return (
      <div className="flex flex-col items-start gap-2 rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-text-primary">
        <p role="alert">{SUBSCRIPTION_MESSAGES.reauth}</p>
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

function CreatePlan() {
  const [state, formAction, pending] = useActionState(createPlanAction, INITIAL);
  // Open from the answer it was opened against until a NEW success arrives
  // (an error keeps it open with what was typed).
  const [openedAt, setOpenedAt] = useState<ActionState<PlatformPlan> | null>(null);
  const open = openedAt !== null && (openedAt === state || state.outcome?.kind !== "ok");
  const created = !open && openedAt !== null && state.outcome?.kind === "ok";
  // Controlled: React resets uncontrolled fields after a form action.
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const message = useRef<HTMLDivElement>(null);
  const refused = open && state !== openedAt && state.outcome !== null && state.outcome.kind !== "ok";

  useEffect(() => {
    if (open) nameInput.current?.focus();
  }, [open]);
  useEffect(() => {
    if (refused) message.current?.focus();
  }, [refused, state]);
  useEffect(() => {
    if (created) trigger.current?.focus();
  }, [created]);

  if (!open) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="status" className={created ? "rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary" : "sr-only"}>
          {created ? "Plan created with a draft version 1. Review its modules, then publish it." : ""}
        </p>
        <button
          ref={trigger}
          type="button"
          onClick={() => {
            setName("");
            setKey("");
            setDescription("");
            setOpenedAt(state);
          }}
          className={PRIMARY}
        >
          {created ? "Create another plan" : "Create a plan"}
        </button>
      </div>
    );
  }
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-4 rounded-2xl border border-border-default bg-surface-card p-5"
    >
      <h2 id={`${id}-title`} className="text-base font-semibold text-text-primary">
        Create a plan
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-name`} className="text-sm font-medium text-text-primary">
            Name
          </label>
          <input
            ref={nameInput}
            id={`${id}-name`}
            name="name"
            required
            maxLength={80}
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={platformInputClassName}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-key`} className="text-sm font-medium text-text-primary">
            Key
          </label>
          <input
            id={`${id}-key`}
            name="key"
            required
            maxLength={50}
            spellCheck={false}
            autoComplete="off"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            aria-describedby={`${id}-key-hint`}
            className={`${platformInputClassName} font-mono`}
          />
          <span id={`${id}-key-hint`} className="text-xs text-text-secondary">
            A permanent identifier, e.g. growth.
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-description`} className="text-sm font-medium text-text-primary">
          Description <span className="font-normal text-text-secondary">(optional)</span>
        </label>
        <input
          id={`${id}-description`}
          name="description"
          maxLength={300}
          autoComplete="off"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className={platformInputClassName}
        />
      </div>
      <ModuleChecks />
      <div ref={message} tabIndex={-1} className="focus:outline-none">
        {refused ? <Outcome state={state} /> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" aria-disabled={pending} aria-busy={pending} className={PRIMARY}>
          {pending ? "Creating…" : "Create plan (as a draft)"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpenedAt(null);
            requestAnimationFrame(() => trigger.current?.focus());
          }}
          className={SECONDARY}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ModuleChecks() {
  return <ModuleCheckboxes selected={[]} legend="Modules in version 1" />;
}

function VersionRow({ plan, version }: { plan: PlatformPlan; version: PlatformPlanVersion }) {
  const [state, formAction, pending] = useActionState(planVersionAction, INITIAL);
  const [confirming, setConfirming] = useState<"publish" | "retire" | null>(null);
  const confirmRegion = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const message = useRef<HTMLDivElement>(null);
  const refused = state.outcome !== null && state.outcome.kind !== "ok";

  useEffect(() => {
    if (confirming) confirmRegion.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (refused) message.current?.focus();
  }, [refused, state]);

  const cancelConfirm = () => {
    setConfirming(null);
    requestAnimationFrame(() =>
      actions.current?.querySelector<HTMLButtonElement>("button")?.focus(),
    );
  };

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border-default p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-text-primary">
          Version {version.version}{" "}
          <span className="ml-1 rounded-full border border-border-default px-2 py-0.5 text-xs font-medium">
            {VERSION_STATUS_LABELS[version.status]}
          </span>
        </p>
        <p className="text-xs text-text-secondary">
          {version.subscriberCount} {version.subscriberCount === 1 ? "business" : "businesses"} subscribed
        </p>
      </div>
      <form
        action={formAction}
        onSubmit={(event) => {
          if (pending) event.preventDefault();
        }}
        className="flex flex-col gap-3"
      >
        <input type="hidden" name="planId" value={plan.id} />
        <input type="hidden" name="versionId" value={version.id} />
        {version.status === "DRAFT" ? (
          <ModuleCheckboxes selected={version.moduleKeys} legend="Modules" />
        ) : (
          <ModuleChips keys={version.moduleKeys} />
        )}
        <div ref={message} tabIndex={-1} className="focus:outline-none">
          <Outcome state={state} />
        </div>
        {confirming ? (
          <div
            ref={confirmRegion}
            tabIndex={-1}
            role="group"
            aria-label={confirming === "publish" ? "Confirm publishing" : "Confirm retiring"}
            className="flex flex-col gap-2 rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary focus:outline-none"
          >
            <p>
              {confirming === "publish"
                ? "Publishing freezes these modules permanently and makes this version available to businesses. Later changes need a new version."
                : "Retiring stops offering this version. Businesses already on it keep it until they are moved."}
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="submit" name="intent" value={confirming} aria-disabled={pending} className={PRIMARY}>
                {confirming === "publish" ? "Publish version" : "Retire version"}
              </button>
              <button type="button" onClick={cancelConfirm} className={SECONDARY}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div ref={actions} className="flex flex-wrap gap-2">
            {version.status === "DRAFT" ? (
              <>
                <button type="submit" name="intent" value="save-draft" aria-disabled={pending} className={SECONDARY}>
                  {pending ? "Saving…" : "Save draft"}
                </button>
                <button type="button" onClick={() => setConfirming("publish")} className={PRIMARY}>
                  Publish…
                </button>
              </>
            ) : version.status === "PUBLISHED" ? (
              <button type="button" onClick={() => setConfirming("retire")} className={SECONDARY}>
                Retire…
              </button>
            ) : null}
          </div>
        )}
      </form>
    </li>
  );
}

function NewVersion({ plan }: { plan: PlatformPlan }) {
  const [state, formAction, pending] = useActionState(planVersionAction, INITIAL);
  const latest = plan.versions[0];
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col items-start gap-2"
    >
      <input type="hidden" name="planId" value={plan.id} />
      <input type="hidden" name="intent" value="new-version" />
      {latest?.moduleKeys.map((key) => (
        <input key={key} type="hidden" name="moduleKeys" value={key} />
      ))}
      <Outcome state={state} />
      <button type="submit" aria-disabled={pending} className={SECONDARY}>
        {pending ? "Creating…" : "Start a new version (draft)"}
      </button>
    </form>
  );
}

export function PlansManager({ plans }: { plans: readonly PlatformPlan[] }) {
  return (
    <div className="flex flex-col gap-6">
      <CreatePlan />
      {plans.map((plan) => (
        <section
          key={plan.id}
          aria-labelledby={`plan-${plan.id}`}
          className="flex flex-col gap-4 rounded-2xl border border-border-default bg-surface-card p-5"
        >
          <div className="flex flex-col gap-1">
            <h2 id={`plan-${plan.id}`} className="text-lg font-semibold text-text-primary">
              {plan.name}
            </h2>
            <p className="font-mono text-xs text-text-secondary">{plan.key}</p>
            {plan.description ? <p className="text-sm text-text-secondary">{plan.description}</p> : null}
          </div>
          <ul className="flex flex-col gap-3">
            {plan.versions.map((version) => (
              // Keyed by status too: a published/retired version starts afresh.
              <VersionRow key={`${version.id}-${version.status}`} plan={plan} version={version} />
            ))}
          </ul>
          {plan.versions.some((v) => v.status === "DRAFT") ? null : <NewVersion plan={plan} />}
        </section>
      ))}
    </div>
  );
}
