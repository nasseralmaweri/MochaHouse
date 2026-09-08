"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AdminPromotion,
  AdminPromotionOptions,
  PromotionApplicability,
  PromotionDiscountType,
  PromotionKind,
} from "@mocha-house/contracts";
import {
  createPromotionFromBrowser,
  updatePromotionFromBrowser,
} from "@/lib/api-client";
import {
  applicabilityLabel,
  discountTypeLabel,
  isoToDatetimeLocal,
  prepareCreatePromotion,
  prepareUpdatePromotion,
  promotionKindLabel,
  type PromotionFormValues,
} from "@/lib/admin/promotions";
import { formatPrice } from "@/lib/money";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";
import { Card } from "@/components/Card";

// HQ Promotions & Coupons management (Milestone 7E). Create / edit /
// activate / deactivate. The API (`promotions.configure`, CORPORATE-only)
// validates every rule and audits every change. Promotions discount
// merchandise only — never cash value.
export function PromotionsManager({
  initialPromotions,
  options,
}: {
  initialPromotions: AdminPromotion[];
  options: AdminPromotionOptions;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<
    | { kind: "list" }
    | { kind: "create" }
    | { kind: "edit"; promotion: AdminPromotion }
  >({ kind: "list" });
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function toggleActive(promotion: AdminPromotion) {
    setToggleError(null);
    setTogglingId(promotion.id);
    const result = await updatePromotionFromBrowser(promotion.id, {
      isActive: !promotion.isActive,
    });
    setTogglingId(null);
    if (result.outcome === "success") {
      router.refresh();
      return;
    }
    setToggleError(
      result.outcome === "forbidden"
        ? "You don't have permission to manage promotions."
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
        <Button onClick={() => setMode({ kind: "create" })}>New promotion</Button>
      </div>

      {toggleError ? (
        <p role="alert" className="text-sm text-status-warning">
          {toggleError}
        </p>
      ) : null}

      {initialPromotions.length === 0 ? (
        <p className="text-sm text-text-muted">
          No promotions yet. Create one to discount merchandise.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {initialPromotions.map((promotion) => (
            <li key={promotion.id}>
              <Card className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
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
                    {promotion.kind === "COUPON" && promotion.code ? (
                      <span className="rounded bg-surface-subtle px-1.5 py-0.5 font-mono text-xs text-text-secondary">
                        {promotion.code}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-text-secondary">
                    {promotionKindLabel(promotion.kind)} ·{" "}
                    {discountTypeLabel(promotion.discountType)} ·{" "}
                    {describeValue(promotion)} ·{" "}
                    {applicabilityLabel(promotion.applicability)}
                  </span>
                  <span className="text-xs text-text-muted">
                    {promotion.appliesToAllLocations
                      ? "All locations"
                      : promotion.eligibleLocations
                          .map((l) => l.name)
                          .join(", ") || "no locations"}
                    {" · "}
                    {formatWindow(promotion.startsAt, promotion.endsAt)}
                    {promotion.totalRedemptionLimit !== null
                      ? ` · ${promotion.redemptionCount}/${promotion.totalRedemptionLimit} used`
                      : ` · ${promotion.redemptionCount} used`}
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

function describeValue(p: AdminPromotion): string {
  if (p.discountType === "PERCENTAGE_OFF") {
    return `${p.discountValue}% off${
      p.maxDiscountMinorUnits !== null
        ? ` (max ${formatPrice(p.maxDiscountMinorUnits, "USD")})`
        : ""
    }`;
  }
  if (p.discountType === "FIXED_AMOUNT") {
    return `${formatPrice(p.discountValue, "USD")} off`;
  }
  return "free item";
}

function formatWindow(startsAt: string | null, endsAt: string | null): string {
  const fmt = (iso: string) => new Date(iso).toLocaleDateString();
  if (startsAt && endsAt) return `${fmt(startsAt)} – ${fmt(endsAt)}`;
  if (startsAt) return `from ${fmt(startsAt)}`;
  if (endsAt) return `until ${fmt(endsAt)}`;
  return "no date limit";
}

function centsToDollars(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

function PromotionForm({
  options,
  promotion,
  onCancel,
  onSaved,
}: {
  options: AdminPromotionOptions;
  promotion?: AdminPromotion;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const isEdit = promotion !== undefined;
  const [kind] = useState<PromotionKind>(promotion?.kind ?? "AUTOMATIC");
  const [discountType] = useState<PromotionDiscountType>(
    promotion?.discountType ?? "PERCENTAGE_OFF",
  );
  const [values, setValues] = useState<PromotionFormValues>({
    name: promotion?.name ?? "",
    description: promotion?.description ?? "",
    kind: promotion?.kind ?? "AUTOMATIC",
    code: promotion?.code ?? "",
    discountType: promotion?.discountType ?? "PERCENTAGE_OFF",
    percentageValue:
      promotion?.discountType === "PERCENTAGE_OFF"
        ? String(promotion.discountValue)
        : "",
    fixedAmountDollars:
      promotion?.discountType === "FIXED_AMOUNT"
        ? centsToDollars(promotion.discountValue)
        : "",
    maxDiscountDollars: centsToDollars(promotion?.maxDiscountMinorUnits ?? null),
    applicability: promotion?.applicability ?? "ENTIRE_ORDER",
    eligibleProductIds: promotion?.eligibleProducts.map((p) => p.id) ?? [],
    eligibleCategoryIds: promotion?.eligibleCategories.map((c) => c.id) ?? [],
    minimumDollars: centsToDollars(promotion?.minimumSubtotalMinorUnits ?? null),
    appliesToAllLocations: promotion?.appliesToAllLocations ?? false,
    eligibleLocationIds: promotion?.eligibleLocations.map((l) => l.id) ?? [],
    startsAt: isoToDatetimeLocal(promotion?.startsAt ?? null),
    endsAt: isoToDatetimeLocal(promotion?.endsAt ?? null),
    totalRedemptionLimit:
      promotion?.totalRedemptionLimit !== null &&
      promotion?.totalRedemptionLimit !== undefined
        ? String(promotion.totalRedemptionLimit)
        : "",
    perCustomerRedemptionLimit:
      promotion?.perCustomerRedemptionLimit !== null &&
      promotion?.perCustomerRedemptionLimit !== undefined
        ? String(promotion.perCustomerRedemptionLimit)
        : "",
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof PromotionFormValues>(
    key: K,
    value: PromotionFormValues[K],
  ) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setError(null);
  }

  function toggleId(
    list: "eligibleProductIds" | "eligibleCategoryIds" | "eligibleLocationIds",
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
    const formValues: PromotionFormValues = { ...values, kind, discountType };
    const prepared = isEdit
      ? prepareUpdatePromotion(formValues)
      : prepareCreatePromotion(formValues);
    if (!prepared.ok) {
      setError(prepared.error);
      return;
    }
    setPending(true);
    const result = isEdit
      ? await updatePromotionFromBrowser(promotion.id, prepared.value)
      : await createPromotionFromBrowser(
          prepared.value as Parameters<typeof createPromotionFromBrowser>[0],
        );
    setPending(false);
    if (result.outcome === "success") {
      onSaved();
      return;
    }
    if (result.outcome === "forbidden") {
      setError("You don't have permission to manage promotions.");
    } else if (result.outcome === "not-found") {
      setError("That promotion no longer exists.");
    } else {
      setError(result.message);
    }
  }

  const showProducts =
    values.applicability === "SELECTED_PRODUCTS" ||
    (discountType === "FREE_ITEM" &&
      values.applicability !== "SELECTED_CATEGORIES");
  const showCategories = values.applicability === "SELECTED_CATEGORIES";

  return (
    <div className="flex max-w-xl flex-col gap-3 rounded-xl border border-border-default bg-surface-subtle px-4 py-4">
      <p className="text-sm font-semibold text-text-primary">
        {isEdit ? `Edit ${promotion.name}` : "New promotion"}
      </p>

      {!isEdit ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-text-primary">Type</legend>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="radio"
              name="promo-kind"
              checked={values.kind === "AUTOMATIC"}
              onChange={() => set("kind", "AUTOMATIC")}
            />
            Promotion (applies automatically)
          </label>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="radio"
              name="promo-kind"
              checked={values.kind === "COUPON"}
              onChange={() => set("kind", "COUPON")}
            />
            Coupon (customer enters a code)
          </label>
        </fieldset>
      ) : (
        <p className="text-xs text-text-muted">
          {promotionKindLabel(kind)} · {discountTypeLabel(discountType)} (cannot
          be changed)
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

      <FormField label="Description (optional)" htmlFor="promo-description">
        <textarea
          id="promo-description"
          rows={2}
          value={values.description}
          onChange={(e) => set("description", e.target.value)}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

      {values.kind === "COUPON" ? (
        <FormField
          label="Coupon code"
          htmlFor="promo-code"
          hint="Case-insensitive. 3–40 letters, digits, hyphens or underscores."
        >
          <input
            id="promo-code"
            value={values.code}
            onChange={(e) => set("code", e.target.value.toUpperCase())}
            className={`${ADMIN_FIELD_CLASS} font-mono`}
          />
        </FormField>
      ) : null}

      {!isEdit ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-text-primary">
            Discount
          </legend>
          {(["PERCENTAGE_OFF", "FIXED_AMOUNT", "FREE_ITEM"] as const).map((t) => (
            <label
              key={t}
              className="flex items-center gap-2 text-sm text-text-primary"
            >
              <input
                type="radio"
                name="promo-discount-type"
                checked={values.discountType === t}
                onChange={() => set("discountType", t)}
              />
              {discountTypeLabel(t)}
            </label>
          ))}
        </fieldset>
      ) : null}

      {discountType === "PERCENTAGE_OFF" ? (
        <>
          <FormField label="Percent off" htmlFor="promo-pct" hint="1–100.">
            <input
              id="promo-pct"
              inputMode="numeric"
              value={values.percentageValue}
              onChange={(e) => set("percentageValue", e.target.value)}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField
            label="Maximum discount (optional)"
            htmlFor="promo-max"
            hint="e.g. 5.00 — caps the discount for a percentage offer."
          >
            <input
              id="promo-max"
              inputMode="decimal"
              value={values.maxDiscountDollars}
              onChange={(e) => set("maxDiscountDollars", e.target.value)}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
        </>
      ) : null}

      {discountType === "FIXED_AMOUNT" ? (
        <FormField label="Amount off" htmlFor="promo-fixed" hint="e.g. 5.00.">
          <input
            id="promo-fixed"
            inputMode="decimal"
            value={values.fixedAmountDollars}
            onChange={(e) => set("fixedAmountDollars", e.target.value)}
            className={ADMIN_FIELD_CLASS}
          />
        </FormField>
      ) : null}

      <FormField label="Applies to" htmlFor="promo-applicability">
        <select
          id="promo-applicability"
          value={values.applicability}
          onChange={(e) =>
            set("applicability", e.target.value as PromotionApplicability)
          }
          className={ADMIN_FIELD_CLASS}
        >
          <option value="ENTIRE_ORDER" disabled={discountType === "FREE_ITEM"}>
            Whole order
          </option>
          <option value="SELECTED_PRODUCTS">Selected products</option>
          <option value="SELECTED_CATEGORIES">Selected categories</option>
        </select>
      </FormField>

      {showProducts ? (
        <IdPicker
          label="Eligible products"
          options={options.products}
          selected={values.eligibleProductIds}
          onToggle={(id) => toggleId("eligibleProductIds", id)}
        />
      ) : null}
      {showCategories ? (
        <IdPicker
          label="Eligible categories"
          options={options.categories}
          selected={values.eligibleCategoryIds}
          onToggle={(id) => toggleId("eligibleCategoryIds", id)}
        />
      ) : null}

      <FormField
        label="Minimum purchase (optional)"
        htmlFor="promo-min"
        hint="e.g. 20.00 — on the merchandise subtotal, before any discount."
      >
        <input
          id="promo-min"
          inputMode="decimal"
          value={values.minimumDollars}
          onChange={(e) => set("minimumDollars", e.target.value)}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

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

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Starts (optional)" htmlFor="promo-starts">
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
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Total limit (optional)" htmlFor="promo-total-limit">
          <input
            id="promo-total-limit"
            inputMode="numeric"
            value={values.totalRedemptionLimit}
            onChange={(e) => set("totalRedemptionLimit", e.target.value)}
            className={ADMIN_FIELD_CLASS}
          />
        </FormField>
        <FormField
          label="Per-customer limit (optional)"
          htmlFor="promo-pc-limit"
          hint="Requires customer sign-in."
        >
          <input
            id="promo-pc-limit"
            inputMode="numeric"
            value={values.perCustomerRedemptionLimit}
            onChange={(e) =>
              set("perCustomerRedemptionLimit", e.target.value)
            }
            className={ADMIN_FIELD_CLASS}
          />
        </FormField>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void submit()} disabled={pending}>
          {pending ? "Saving…" : isEdit ? "Save promotion" : "Create promotion"}
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
