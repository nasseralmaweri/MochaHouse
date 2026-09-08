"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AdminLoyaltyBonusPromotion,
  AdminLoyaltyBonusPromotionOptions,
  LoyaltyBonusPromotionType,
} from "@mocha-house/contracts";
import {
  createLoyaltyBonusPromotionFromBrowser,
  updateLoyaltyBonusPromotionFromBrowser,
} from "@/lib/api-client";
import {
  bonusTypeLabel,
  bonusValueLabel,
  isoToDatetimeLocal,
  prepareCreateBonusPromotion,
  prepareUpdateBonusPromotion,
  type BonusPromotionFormValues,
} from "@/lib/admin/loyalty-bonus-promotions";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";
import { Card } from "@/components/Card";

// HQ Bonus Mocha Beans Promotions management (Milestone 7D). Create / edit /
// activate / deactivate. The API (`loyalty.configure`, CORPORATE-only)
// validates every rule and audits every change. Promotions award Beans
// only — they never discount money.
export function BonusPromotionsManager({
  initialPromotions,
  options,
}: {
  initialPromotions: AdminLoyaltyBonusPromotion[];
  options: AdminLoyaltyBonusPromotionOptions;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<
    | { kind: "list" }
    | { kind: "create" }
    | { kind: "edit"; promotion: AdminLoyaltyBonusPromotion }
  >({ kind: "list" });
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function toggleActive(promotion: AdminLoyaltyBonusPromotion) {
    setToggleError(null);
    setTogglingId(promotion.id);
    const result = await updateLoyaltyBonusPromotionFromBrowser(promotion.id, {
      isActive: !promotion.isActive,
    });
    setTogglingId(null);
    if (result.outcome === "success") {
      router.refresh();
      return;
    }
    setToggleError(
      result.outcome === "forbidden"
        ? "You don't have permission to manage bonus promotions."
        : result.outcome === "not-found"
          ? "That promotion no longer exists."
          : result.message,
    );
  }

  if (mode.kind === "create" || mode.kind === "edit") {
    return (
      <PromotionForm
        options={options}
        promotion={mode.kind === "edit" ? mode.promotion : undefined}
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
        <Button onClick={() => setMode({ kind: "create" })}>
          New bonus promotion
        </Button>
      </div>

      {toggleError ? (
        <p role="alert" className="text-sm text-status-warning">
          {toggleError}
        </p>
      ) : null}

      {initialPromotions.length === 0 ? (
        <p className="text-sm text-text-muted">
          No bonus promotions yet. Create one to award extra Mocha Beans on
          chosen products.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {initialPromotions.map((promotion) => (
            <li key={promotion.id}>
              <Card className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-text-primary">
                      {promotion.name}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        promotion.isActive
                          ? "bg-status-success/10 text-status-success"
                          : "bg-surface-subtle text-text-muted"
                      }`}
                    >
                      {promotion.isActive ? "Active" : "Inactive"}
                    </span>
                  </span>
                  <span className="text-xs text-text-secondary">
                    {bonusTypeLabel(promotion.type)} ·{" "}
                    {bonusValueLabel(promotion.type, promotion.bonusValue)}
                  </span>
                  <span className="text-xs text-text-muted">
                    {promotion.eligibleProducts.map((p) => p.name).join(", ") ||
                      "no products"}
                  </span>
                  <span className="text-xs text-text-muted">
                    {promotion.appliesToAllLocations
                      ? "All locations"
                      : promotion.eligibleLocations
                          .map((l) => l.name)
                          .join(", ") || "no locations"}
                    {" · "}
                    {formatWindow(promotion.startsAt, promotion.endsAt)}
                  </span>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setMode({ kind: "edit", promotion })}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={togglingId === promotion.id}
                    onClick={() => void toggleActive(promotion)}
                  >
                    {promotion.isActive ? "Deactivate" : "Activate"}
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

function formatWindow(startsAt: string | null, endsAt: string | null): string {
  const fmt = (iso: string) => new Date(iso).toLocaleDateString();
  if (startsAt && endsAt) return `${fmt(startsAt)} – ${fmt(endsAt)}`;
  if (startsAt) return `from ${fmt(startsAt)}`;
  if (endsAt) return `until ${fmt(endsAt)}`;
  return "no date limit";
}

function PromotionForm({
  options,
  promotion,
  onCancel,
  onSaved,
}: {
  options: AdminLoyaltyBonusPromotionOptions;
  promotion?: AdminLoyaltyBonusPromotion;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const isEdit = promotion !== undefined;
  const [type, setType] = useState<LoyaltyBonusPromotionType>(
    promotion?.type ?? "EXTRA_BEANS",
  );
  const [values, setValues] = useState<BonusPromotionFormValues>({
    name: promotion?.name ?? "",
    type: promotion?.type ?? "EXTRA_BEANS",
    bonusValue: promotion ? String(promotion.bonusValue) : "",
    eligibleProductIds: promotion?.eligibleProducts.map((p) => p.id) ?? [],
    appliesToAllLocations: promotion?.appliesToAllLocations ?? false,
    eligibleLocationIds: promotion?.eligibleLocations.map((l) => l.id) ?? [],
    startsAt: isoToDatetimeLocal(promotion?.startsAt ?? null),
    endsAt: isoToDatetimeLocal(promotion?.endsAt ?? null),
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof BonusPromotionFormValues>(
    key: K,
    value: BonusPromotionFormValues[K],
  ) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setError(null);
  }

  function toggleId(
    list: "eligibleProductIds" | "eligibleLocationIds",
    id: string,
  ) {
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
    const formValues: BonusPromotionFormValues = { ...values, type };
    const prepared = isEdit
      ? prepareUpdateBonusPromotion(formValues)
      : prepareCreateBonusPromotion(formValues);
    if (!prepared.ok) {
      setError(prepared.error);
      return;
    }

    setPending(true);
    const result = isEdit
      ? await updateLoyaltyBonusPromotionFromBrowser(promotion.id, prepared.value)
      : await createLoyaltyBonusPromotionFromBrowser(
          prepared.value as Parameters<
            typeof createLoyaltyBonusPromotionFromBrowser
          >[0],
        );
    setPending(false);

    if (result.outcome === "success") {
      onSaved();
      return;
    }
    if (result.outcome === "forbidden") {
      setError("You don't have permission to manage bonus promotions.");
    } else if (result.outcome === "not-found") {
      setError("That promotion no longer exists.");
    } else {
      setError(result.message);
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-3 rounded-xl border border-border-default bg-surface-subtle px-4 py-4">
      <p className="text-sm font-semibold text-text-primary">
        {isEdit ? `Edit ${promotion.name}` : "New bonus promotion"}
      </p>

      {!isEdit ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-text-primary">
            Bonus type
          </legend>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="radio"
              name="bonus-type"
              checked={type === "EXTRA_BEANS"}
              onChange={() => {
                setType("EXTRA_BEANS");
                setError(null);
              }}
            />
            Extra Beans (flat amount per qualifying item)
          </label>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="radio"
              name="bonus-type"
              checked={type === "MULTIPLIER"}
              onChange={() => {
                setType("MULTIPLIER");
                setError(null);
              }}
            />
            Multiplier (total earning × N on qualifying item)
          </label>
        </fieldset>
      ) : (
        <p className="text-xs text-text-muted">
          Type: {bonusTypeLabel(type)} (cannot be changed)
        </p>
      )}

      <FormField label="Name" htmlFor="promo-name">
        <input
          id="promo-name"
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

      <FormField
        label={type === "EXTRA_BEANS" ? "Extra Beans per item" : "Multiplier"}
        htmlFor="promo-bonus-value"
        hint={
          type === "EXTRA_BEANS"
            ? "Whole Beans added for every qualifying paid unit, e.g. 20."
            : "Whole number, 2–10. 2× means the item earns twice its standard Beans."
        }
      >
        <input
          id="promo-bonus-value"
          inputMode="numeric"
          value={values.bonusValue}
          onChange={(e) => set("bonusValue", e.target.value)}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

      <IdPicker
        label="Eligible products"
        options={options.products}
        selected={values.eligibleProductIds}
        onToggle={(id) => toggleId("eligibleProductIds", id)}
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-text-primary">
          Locations
        </legend>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="radio"
            name="promo-locations"
            checked={values.appliesToAllLocations}
            onChange={() => set("appliesToAllLocations", true)}
          />
          All locations
        </label>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="radio"
            name="promo-locations"
            checked={!values.appliesToAllLocations}
            onChange={() => set("appliesToAllLocations", false)}
          />
          Selected locations
        </label>
        {!values.appliesToAllLocations ? (
          <IdPicker
            label="Selected locations"
            options={options.locations}
            selected={values.eligibleLocationIds}
            onToggle={(id) => toggleId("eligibleLocationIds", id)}
          />
        ) : null}
      </fieldset>

      <FormField
        label="Starts (optional)"
        htmlFor="promo-starts"
        hint="Leave blank for no start bound. Uses your local time."
      >
        <input
          id="promo-starts"
          type="datetime-local"
          value={values.startsAt}
          onChange={(e) => set("startsAt", e.target.value)}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

      <FormField label="Ends (optional)" htmlFor="promo-ends">
        <input
          id="promo-ends"
          type="datetime-local"
          value={values.endsAt}
          onChange={(e) => set("endsAt", e.target.value)}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void submit()} disabled={pending}>
          {pending
            ? "Saving…"
            : isEdit
              ? "Save promotion"
              : "Create promotion"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function IdPicker({
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
