"use client";

import { useActionState, useState } from "react";
import {
  SUBSCRIPTION_MODULES,
  type OwnerOnboardingPlanOption,
} from "@mocha-house/contracts";
import {
  createBusinessAction,
  enterBusinessAction,
} from "@/lib/internal-auth/onboarding-actions";
import {
  INITIAL_CREATE_BUSINESS_STATE,
  formatPlanPrice,
  priceChoiceValue,
} from "@/lib/internal-auth/onboarding-state";

const inputClassName =
  "min-h-11 rounded-lg border border-border-default bg-surface-card px-3.5 py-2.5 text-base text-text-primary transition-colors hover:border-text-muted/50 focus-visible:border-focus focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus";
const primaryButtonClassName =
  "flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-base font-semibold text-accent-contrast transition-opacity hover:opacity-90 disabled:bg-surface-subtle disabled:text-text-muted";

const MODULE_LABELS = new Map(SUBSCRIPTION_MODULES.map((m) => [m.key, m.label]));

function ErrorMessage({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error">
      {error}
    </p>
  ) : null;
}

export function CreateBusinessForm({ plans }: { plans: OwnerOnboardingPlanOption[] }) {
  const [state, formAction, pending] = useActionState(
    createBusinessAction,
    INITIAL_CREATE_BUSINESS_STATE,
  );
  // Controlled, so a refused attempt (e.g. a price that changed) keeps what
  // the owner entered — React resets an uncontrolled form after an action.
  const [businessName, setBusinessName] = useState("");
  const [choice, setChoice] = useState("");

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col gap-6"
    >
      <label className="flex flex-col gap-1.5 text-sm font-medium text-text-primary">
        Business name
        <input
          required
          name="businessName"
          autoComplete="organization"
          minLength={2}
          maxLength={120}
          value={businessName}
          onChange={(event) => setBusinessName(event.target.value)}
          className={inputClassName}
        />
      </label>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-text-primary">Choose a plan</legend>
        {plans.map((plan) => {
          const detailsId = `plan-${plan.planVersionId}-details`;
          return (
            <fieldset
              key={plan.planVersionId}
              aria-describedby={detailsId}
              className="rounded-xl border border-border-default p-4"
            >
              <legend className="px-1 text-base font-semibold text-text-primary">{plan.name}</legend>
              <div id={detailsId}>
                {plan.description ? (
                  <p className="text-sm text-text-secondary">{plan.description}</p>
                ) : null}
                <p className="mt-1 text-xs text-text-muted">
                  Includes: {plan.modules.map((key) => MODULE_LABELS.get(key) ?? key).join(", ")}
                </p>
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {plan.prices.map((price) => {
                  const value = priceChoiceValue(plan, price);
                  return (
                    <label
                      key={price.planPriceId}
                      className="flex min-h-11 items-center gap-3 text-sm text-text-primary"
                    >
                      <input
                        required
                        type="radio"
                        name="priceChoice"
                        value={value}
                        checked={choice === value}
                        onChange={() => setChoice(value)}
                        className="size-4"
                      />
                      {plan.name}: {formatPlanPrice(price)}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </fieldset>

      <p className="text-sm text-text-secondary">
        No charge today. You&apos;ll set up payment next, and the price you choose applies only from
        then. Until payment is set up, your plan&apos;s extra modules and online ordering stay off — you
        can already start setting up your business.
      </p>

      <ErrorMessage error={state.error} />

      <button type="submit" disabled={pending} className={primaryButtonClassName}>
        {pending ? "Creating your business…" : "Create business"}
      </button>
    </form>
  );
}

export function EnterBusinessForm() {
  const [state, formAction, pending] = useActionState(
    enterBusinessAction,
    INITIAL_CREATE_BUSINESS_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <p className="text-sm text-text-secondary">
        Your business has been created. Payment setup comes next — nothing has been charged.
      </p>
      <ErrorMessage error={state.error} />
      <button type="submit" disabled={pending} className={primaryButtonClassName}>
        {pending ? "Opening…" : "Open your business"}
      </button>
    </form>
  );
}
