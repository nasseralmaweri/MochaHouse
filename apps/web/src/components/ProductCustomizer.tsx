"use client";

import { useMemo, useState } from "react";
import type {
  ModifierGroupSummary,
  ModifierOptionSummary,
  ProductSummary,
} from "@mocha-house/contracts";
import { formatPrice } from "@/lib/money";

type SelectionState = Record<string, string[]>;

function sortByDisplayOrder<T extends { displayOrder: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.displayOrder - b.displayOrder);
}

// Required, single-choice groups (e.g. Size) start with their first option
// pre-selected so the displayed total is always a complete, valid price
// immediately. Optional and multi-select groups start empty.
function defaultSelections(modifierGroups: ModifierGroupSummary[]): SelectionState {
  const initial: SelectionState = {};

  for (const group of modifierGroups) {
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
}: {
  product: ProductSummary;
  effectivePrice: number | null;
  modifierGroups: ModifierGroupSummary[];
}) {
  const [selections, setSelections] = useState<SelectionState>(() =>
    defaultSelections(modifierGroups),
  );

  const total = useMemo(() => {
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

      <div className="sticky bottom-0 flex flex-col gap-3 border-t border-border-default bg-surface-page pt-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-secondary">Total</span>
          <span className="text-lg font-semibold text-text-primary">
            {formatPrice(total, product.currency)}
          </span>
        </div>
        <button
          type="button"
          disabled
          className="flex min-h-11 items-center justify-center rounded-xl border border-border-default bg-surface-subtle px-4 py-3 text-base font-semibold text-text-muted"
        >
          Add to cart
        </button>
        <p className="text-center text-xs text-text-muted">
          Cart isn&apos;t available yet.
        </p>
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
