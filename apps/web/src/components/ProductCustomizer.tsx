"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ModifierGroupSummary,
  ModifierOptionSummary,
  ProductSummary,
} from "@mocha-house/contracts";
import { formatPrice } from "@/lib/money";
import {
  useCart,
  type AddItemInput,
  type CartLineSelection,
} from "@/lib/cart/store";
import { Card } from "@/components/Card";
import { BackLink } from "@/components/BackLink";
import { QuantityStepper } from "@/components/QuantityStepper";

type SelectionState = Record<string, string[]>;

function sortByDisplayOrder<T extends { displayOrder: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.displayOrder - b.displayOrder);
}

// Required, single-choice groups (e.g. Size) start with their first option
// pre-selected so the displayed total is always a complete, valid price
// immediately. Optional and multi-select groups start empty. When editing
// an existing cart line, its saved selections seed the state instead — but
// only options that still exist in the current (authoritative) modifier
// groups are honored, so a since-removed option naturally surfaces as
// unselected rather than silently carried over.
function defaultSelections(
  modifierGroups: ModifierGroupSummary[],
  seed?: SelectionState,
): SelectionState {
  const initial: SelectionState = {};

  for (const group of modifierGroups) {
    const validOptionIds = new Set(group.options.map((option) => option.id));
    const seededIds = seed?.[group.id]?.filter((id) => validOptionIds.has(id));

    if (seededIds && seededIds.length > 0) {
      initial[group.id] = seededIds;
      continue;
    }

    if (group.isRequired && group.maxSelections === 1) {
      const [firstOption] = sortByDisplayOrder(group.options);
      initial[group.id] = firstOption ? [firstOption.id] : [];
    } else {
      initial[group.id] = [];
    }
  }

  return initial;
}

function selectionHint(group: ModifierGroupSummary): string {
  if (group.maxSelections === 1) {
    return group.isRequired ? "Choose 1" : "Choose up to 1";
  }

  if (group.maxSelections === null) {
    return group.isRequired
      ? `Choose at least ${group.minSelections}`
      : "Optional";
  }

  return group.isRequired
    ? `Choose ${group.minSelections}–${group.maxSelections}`
    : `Choose up to ${group.maxSelections}`;
}

export function ProductCustomizer({
  product,
  effectivePrice,
  modifierGroups,
  locationId,
  locationName,
  menuId,
  editLineId,
}: {
  product: ProductSummary;
  effectivePrice: number | null;
  modifierGroups: ModifierGroupSummary[];
  locationId: string;
  locationName: string;
  menuId: string;
  editLineId?: string;
}) {
  const router = useRouter();
  const cart = useCart();

  const editingLine = editLineId
    ? cart.lines.find((line) => line.lineId === editLineId)
    : undefined;

  const seedSelections = useMemo<SelectionState | undefined>(() => {
    if (!editingLine) {
      return undefined;
    }
    const seed: SelectionState = {};
    for (const selection of editingLine.selections) {
      seed[selection.groupId] = selection.optionIds;
    }
    return seed;
  }, [editingLine]);

  const [selections, setSelections] = useState<SelectionState>(() =>
    defaultSelections(modifierGroups, seedSelections),
  );
  const [quantity, setQuantity] = useState<number>(editingLine?.quantity ?? 1);
  const [locationConflict, setLocationConflict] = useState(false);
  const [justAdded, setJustAdded] = useState(false);

  const unitPrice = useMemo(() => {
    if (effectivePrice === null) {
      return null;
    }

    let amount = effectivePrice;

    for (const group of modifierGroups) {
      const selectedIds = selections[group.id] ?? [];
      for (const option of group.options) {
        if (selectedIds.includes(option.id)) {
          amount += option.priceAdjustment;
        }
      }
    }

    return amount;
  }, [effectivePrice, modifierGroups, selections]);

  const displayTotal = unitPrice === null ? null : unitPrice * quantity;

  function selectSingle(groupId: string, optionId: string) {
    setSelections((prev) => ({ ...prev, [groupId]: [optionId] }));
  }

  function toggleMultiple(
    groupId: string,
    optionId: string,
    maxSelections: number | null,
  ) {
    setSelections((prev) => {
      const current = prev[groupId] ?? [];

      if (current.includes(optionId)) {
        return {
          ...prev,
          [groupId]: current.filter((id) => id !== optionId),
        };
      }

      if (maxSelections !== null && current.length >= maxSelections) {
        return prev;
      }

      return { ...prev, [groupId]: [...current, optionId] };
    });
  }

  function buildSelectionsPayload(): CartLineSelection[] {
    return sortByDisplayOrder(modifierGroups).flatMap((group) => {
      const optionIds = selections[group.id] ?? [];
      if (optionIds.length === 0) {
        return [];
      }
      const optionNames = group.options
        .filter((option) => optionIds.includes(option.id))
        .map((option) => option.name);
      return [{ groupId: group.id, groupName: group.name, optionIds, optionNames }];
    });
  }

  function buildAddItemInput(): AddItemInput | null {
    if (unitPrice === null) {
      return null;
    }

    return {
      productId: product.id,
      productName: product.name,
      currency: product.currency,
      menuId,
      locationId,
      locationName,
      quantity,
      selections: buildSelectionsPayload(),
      unitPriceAtAdd: unitPrice,
    };
  }

  function handleAddToCart() {
    const input = buildAddItemInput();
    if (!input) {
      return;
    }

    const result = cart.addItem(input);
    if (!result.ok) {
      setLocationConflict(true);
      return;
    }

    setLocationConflict(false);
    setJustAdded(true);
  }

  function handleReplaceCart() {
    const input = buildAddItemInput();
    if (!input) {
      return;
    }

    cart.replaceCartWithItem(input);
    setLocationConflict(false);
    setJustAdded(true);
  }

  function handleUpdateCart() {
    if (!editingLine || unitPrice === null) {
      return;
    }

    cart.updateLine(editingLine.lineId, {
      selections: buildSelectionsPayload(),
      quantity,
      unitPriceAtAdd: unitPrice,
    });
    router.push("/order/cart");
  }

  function handleRemoveFromCart() {
    if (!editingLine) {
      return;
    }

    cart.removeLine(editingLine.lineId);
    router.push("/order/cart");
  }

  const cartHasOtherLocation =
    cart.isHydrated &&
    cart.locationId !== null &&
    cart.locationId !== locationId &&
    cart.lines.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          {product.name}
        </h1>
        {product.description ? (
          <p className="text-sm text-text-secondary">{product.description}</p>
        ) : null}
      </div>

      {cartHasOtherLocation && !editingLine ? (
        <Card tone="subtle" className="text-sm text-text-muted">
          Your cart has items from {cart.locationName ?? "another location"}.
          Adding this item will start a new cart at {locationName}.
        </Card>
      ) : null}

      {sortByDisplayOrder(modifierGroups).map((group) => (
        <ModifierGroupFieldset
          key={group.id}
          group={group}
          currency={product.currency}
          selectedIds={selections[group.id] ?? []}
          onSelectSingle={(optionId) => selectSingle(group.id, optionId)}
          onToggleMultiple={(optionId) =>
            toggleMultiple(group.id, optionId, group.maxSelections)
          }
        />
      ))}

      <QuantityStepper quantity={quantity} onChange={setQuantity} />

      <div className="sticky bottom-0 flex flex-col gap-3 border-t border-border-default bg-surface-page pt-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-secondary">Total</span>
          <span className="text-lg font-semibold text-text-primary">
            {formatPrice(displayTotal, product.currency)}
          </span>
        </div>

        {locationConflict ? (
          <div className="flex flex-col gap-3 rounded-xl border border-border-default bg-surface-subtle px-4 py-3">
            <p className="text-sm text-text-muted">
              Your cart has items from {cart.locationName ?? "a different location"}.
              Starting a new cart here will clear those items.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={handleReplaceCart}
                className="flex min-h-11 items-center justify-center rounded-xl border border-border-default bg-surface-card px-4 py-2 text-sm font-semibold text-text-primary"
              >
                Clear cart and add this item
              </button>
              <BackLink href="/order/cart">Review current cart</BackLink>
            </div>
          </div>
        ) : editingLine ? (
          <>
            <button
              type="button"
              onClick={handleUpdateCart}
              disabled={unitPrice === null}
              className="flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-3 text-base font-semibold text-status-success disabled:bg-surface-subtle disabled:text-text-muted"
            >
              Update cart
            </button>
            <button
              type="button"
              onClick={handleRemoveFromCart}
              className="text-center text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Remove from cart
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={handleAddToCart}
              disabled={unitPrice === null}
              className="flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-3 text-base font-semibold text-status-success disabled:bg-surface-subtle disabled:text-text-muted"
            >
              Add to cart
            </button>
            {justAdded ? (
              <p className="text-center text-xs text-text-muted">
                Added to cart. <BackLink href="/order/cart">View cart</BackLink>
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function ModifierGroupFieldset({
  group,
  currency,
  selectedIds,
  onSelectSingle,
  onToggleMultiple,
}: {
  group: ModifierGroupSummary;
  currency: string;
  selectedIds: string[];
  onSelectSingle: (optionId: string) => void;
  onToggleMultiple: (optionId: string) => void;
}) {
  const isSingleSelect = group.maxSelections === 1;

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 flex w-full items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-text-primary">
          {group.name}
        </span>
        <span className="text-xs text-text-muted">{selectionHint(group)}</span>
      </legend>
      <div className="flex flex-col gap-2">
        {sortByDisplayOrder(group.options).map((option) => (
          <ModifierOptionRow
            key={option.id}
            option={option}
            currency={currency}
            inputType={isSingleSelect ? "radio" : "checkbox"}
            groupId={group.id}
            checked={selectedIds.includes(option.id)}
            onChange={() =>
              isSingleSelect
                ? onSelectSingle(option.id)
                : onToggleMultiple(option.id)
            }
          />
        ))}
      </div>
    </fieldset>
  );
}

function ModifierOptionRow({
  option,
  currency,
  inputType,
  groupId,
  checked,
  onChange,
}: {
  option: ModifierOptionSummary;
  currency: string;
  inputType: "radio" | "checkbox";
  groupId: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-xl border border-border-default bg-surface-card px-4 py-3">
      <span className="flex items-center gap-3">
        <input
          type={inputType}
          name={groupId}
          checked={checked}
          onChange={onChange}
          className="h-5 w-5 accent-text-primary"
        />
        <span className="text-base text-text-primary">{option.name}</span>
      </span>
      <span className="text-sm text-text-secondary">
        {option.priceAdjustment === 0
          ? "Included"
          : `+${formatPrice(option.priceAdjustment, currency)}`}
      </span>
    </label>
  );
}
