"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AdminLoyaltyCatalogOptions,
  AdminLoyaltyReward,
  LoyaltyRewardType,
} from "@mocha-house/contracts";
import {
  createLoyaltyRewardFromBrowser,
  updateLoyaltyRewardFromBrowser,
} from "@/lib/api-client";
import {
  prepareCreateReward,
  prepareUpdateReward,
  rewardTypeLabel,
  type RewardFormValues,
} from "@/lib/admin/loyalty-rewards";
import { formatPrice } from "@/lib/money";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";
import { Card } from "@/components/Card";

// HQ Rewards Catalog management (Milestone 7B). Create / edit / activate /
// deactivate. The API (`loyalty.configure`, CORPORATE-only) validates every
// rule and audits every change. NO redemption — this is catalog only.
export function RewardsManager({
  initialRewards,
  catalog,
}: {
  initialRewards: AdminLoyaltyReward[];
  catalog: AdminLoyaltyCatalogOptions;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "edit"; reward: AdminLoyaltyReward }
  >({ kind: "list" });
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function toggleActive(reward: AdminLoyaltyReward) {
    setToggleError(null);
    setTogglingId(reward.id);
    const result = await updateLoyaltyRewardFromBrowser(reward.id, {
      isActive: !reward.isActive,
    });
    setTogglingId(null);
    if (result.outcome === "success") {
      router.refresh();
      return;
    }
    setToggleError(
      result.outcome === "forbidden"
        ? "You don't have permission to manage rewards."
        : result.outcome === "not-found"
          ? "That reward no longer exists."
          : result.message,
    );
  }

  if (mode.kind === "create") {
    return (
      <RewardForm
        catalog={catalog}
        onCancel={() => setMode({ kind: "list" })}
        onSaved={() => {
          setMode({ kind: "list" });
          router.refresh();
        }}
      />
    );
  }

  if (mode.kind === "edit") {
    return (
      <RewardForm
        catalog={catalog}
        reward={mode.reward}
        onCancel={() => setMode({ kind: "list" })}
        onSaved={() => {
          setMode({ kind: "list" });
          router.refresh();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button onClick={() => setMode({ kind: "create" })}>New reward</Button>
      </div>

      {toggleError ? (
        <p role="alert" className="text-sm text-status-warning">
          {toggleError}
        </p>
      ) : null}

      {initialRewards.length === 0 ? (
        <p className="text-sm text-text-muted">
          No rewards yet. Create one for customers to see in their account.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {initialRewards.map((reward) => (
            <li key={reward.id}>
              <Card className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-text-primary">
                      {reward.name}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        reward.isActive
                          ? "bg-status-success/10 text-status-success"
                          : "bg-surface-subtle text-text-muted"
                      }`}
                    >
                      {reward.isActive ? "Active" : "Inactive"}
                    </span>
                  </span>
                  <span className="text-xs text-text-secondary">
                    {rewardTypeLabel(reward.type)} · {reward.beanCost} Beans
                    {reward.type === "FIXED_AMOUNT" &&
                    reward.fixedAmountMinorUnits !== null
                      ? ` · ${formatPrice(reward.fixedAmountMinorUnits, "USD")} off`
                      : ""}
                  </span>
                  {reward.type === "FREE_ITEM" ? (
                    <span className="text-xs text-text-muted">
                      {[
                        ...reward.eligibleProducts.map((p) => p.name),
                        ...reward.eligibleCategories.map(
                          (c) => `${c.name} (category)`,
                        ),
                      ].join(", ")}
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setMode({ kind: "edit", reward })}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={togglingId === reward.id}
                    onClick={() => void toggleActive(reward)}
                  >
                    {reward.isActive ? "Deactivate" : "Activate"}
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function centsToDollars(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

function RewardForm({
  catalog,
  reward,
  onCancel,
  onSaved,
}: {
  catalog: AdminLoyaltyCatalogOptions;
  reward?: AdminLoyaltyReward;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const isEdit = reward !== undefined;
  const [type, setType] = useState<LoyaltyRewardType>(
    reward?.type ?? "FIXED_AMOUNT",
  );
  const [values, setValues] = useState<RewardFormValues>({
    name: reward?.name ?? "",
    description: reward?.description ?? "",
    type: reward?.type ?? "FIXED_AMOUNT",
    beanCost: reward ? String(reward.beanCost) : "",
    fixedAmountDollars: centsToDollars(reward?.fixedAmountMinorUnits ?? null),
    eligibleProductIds: reward?.eligibleProducts.map((p) => p.id) ?? [],
    eligibleCategoryIds: reward?.eligibleCategories.map((c) => c.id) ?? [],
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof RewardFormValues>(
    key: K,
    value: RewardFormValues[K],
  ) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setError(null);
  }

  function toggleId(list: "eligibleProductIds" | "eligibleCategoryIds", id: string) {
    setValues((prev) => {
      const current = prev[list];
      return {
        ...prev,
        [list]: current.includes(id)
          ? current.filter((x) => x !== id)
          : [...current, id],
      };
    });
    setError(null);
  }

  async function submit() {
    setError(null);
    const formValues: RewardFormValues = { ...values, type };
    const prepared = isEdit
      ? prepareUpdateReward(formValues)
      : prepareCreateReward(formValues);
    if (!prepared.ok) {
      setError(prepared.error);
      return;
    }

    setPending(true);
    const result = isEdit
      ? await updateLoyaltyRewardFromBrowser(reward.id, prepared.value)
      : await createLoyaltyRewardFromBrowser(
          prepared.value as Parameters<typeof createLoyaltyRewardFromBrowser>[0],
        );
    setPending(false);

    if (result.outcome === "success") {
      onSaved();
      return;
    }
    if (result.outcome === "forbidden") {
      setError("You don't have permission to manage rewards.");
    } else if (result.outcome === "not-found") {
      setError("That reward no longer exists.");
    } else {
      setError(result.message);
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-3 rounded-xl border border-border-default bg-surface-subtle px-4 py-4">
      <p className="text-sm font-semibold text-text-primary">
        {isEdit ? `Edit ${reward.name}` : "New reward"}
      </p>

      {!isEdit ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-text-primary">
            Reward type
          </legend>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="radio"
              name="reward-type"
              checked={type === "FIXED_AMOUNT"}
              onChange={() => {
                setType("FIXED_AMOUNT");
                setError(null);
              }}
            />
            Dollar off
          </label>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="radio"
              name="reward-type"
              checked={type === "FREE_ITEM"}
              onChange={() => {
                setType("FREE_ITEM");
                setError(null);
              }}
            />
            Free item
          </label>
        </fieldset>
      ) : (
        <p className="text-xs text-text-muted">
          Type: {rewardTypeLabel(type)} (cannot be changed)
        </p>
      )}

      <FormField label="Name" htmlFor="reward-name">
        <input
          id="reward-name"
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

      <FormField label="Description (optional)" htmlFor="reward-description">
        <textarea
          id="reward-description"
          rows={2}
          value={values.description}
          onChange={(e) => set("description", e.target.value)}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

      <FormField label="Bean cost" htmlFor="reward-bean-cost">
        <input
          id="reward-bean-cost"
          inputMode="numeric"
          value={values.beanCost}
          onChange={(e) => set("beanCost", e.target.value)}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

      {type === "FIXED_AMOUNT" ? (
        <FormField
          label="Dollar off"
          htmlFor="reward-fixed-amount"
          hint="e.g. 5.00 — capped at the eligible merchandise amount when redeemed."
        >
          <input
            id="reward-fixed-amount"
            inputMode="decimal"
            value={values.fixedAmountDollars}
            onChange={(e) => set("fixedAmountDollars", e.target.value)}
            className={ADMIN_FIELD_CLASS}
          />
        </FormField>
      ) : (
        <div className="flex flex-col gap-3">
          <EligibilityPicker
            label="Eligible products"
            options={catalog.products}
            selected={values.eligibleProductIds}
            onToggle={(id) => toggleId("eligibleProductIds", id)}
          />
          <EligibilityPicker
            label="Eligible categories"
            options={catalog.categories}
            selected={values.eligibleCategoryIds}
            onToggle={(id) => toggleId("eligibleCategoryIds", id)}
          />
        </div>
      )}

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void submit()} disabled={pending}>
          {pending ? "Saving…" : isEdit ? "Save reward" : "Create reward"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function EligibilityPicker({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: { id: string; name: string }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-medium text-text-primary">{label}</legend>
      {options.length === 0 ? (
        <p className="text-xs text-text-muted">None available.</p>
      ) : (
        <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-lg border border-border-default bg-surface-card px-3 py-2">
          {options.map((option) => (
            <label
              key={option.id}
              className="flex items-center gap-2 text-sm text-text-primary"
            >
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                onChange={() => onToggle(option.id)}
              />
              {option.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
