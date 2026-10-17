"use client";

import { useActionState, useState } from "react";
import {
  SUBSCRIPTION_MODULES,
  type OwnerOnboardingPlanOption,
} from "@mocha-house/contracts";
import { changeInitialPlanAction } from "../actions";
import { formatPlanPrice, priceChoiceValue } from "@/lib/internal-auth/onboarding-state";

const PRIMARY =
  "flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-base font-semibold text-accent-contrast transition-opacity hover:opacity-90 disabled:bg-surface-subtle disabled:text-text-muted";

const MODULE_LABELS = new Map(SUBSCRIPTION_MODULES.map((m) => [m.key, m.label]));

export function ChoosePlanForm({
  plans,
  current,
}: {
  plans: OwnerOnboardingPlanOption[];
  current: { planVersionId: string; planPriceId: string };
}) {
  const [state, formAction, pending] = useActionState(changeInitialPlanAction, {
    message: null,
  });
  // The current choice is preselected only if it is still offered.
  const initial =
    plans
      .flatMap((plan) => plan.prices.map((price) => ({ plan, price })))
      .find(
        ({ plan, price }) =>
          plan.planVersionId === current.planVersionId &&
          price.planPriceId === current.planPriceId,
      ) ?? null;
  const [choice, setChoice] = useState(
    initial ? priceChoiceValue(initial.plan, initial.price) : "",
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col gap-5"
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-text-primary">Plan</legend>
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
        Nothing is charged now. The price you choose applies when you finish payment setup. A payment
        setup you had started but not finished is cancelled, so you start it again at the new price.
      </p>
      {state.message ? (
        <p role="alert" className="rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error">
          {state.message}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className={PRIMARY}>
        {pending ? "Saving…" : "Save plan"}
      </button>
    </form>
  );
}
