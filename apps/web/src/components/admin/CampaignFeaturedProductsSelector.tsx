"use client";

import { useState } from "react";
import { CAMPAIGN_FEATURED_PRODUCTS_MAX } from "@mocha-house/contracts";
import { Card } from "@/components/Card";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS } from "./form";

interface SelectableProduct {
  id: string;
  name: string;
  category: { id: string; name: string };
  isActive: boolean;
}

// Admin → Marketing → Campaign → Featured Products (Milestone 8G). A
// campaign stores ONLY an ordered list of product ids — name/category shown
// here are read live from the authoritative catalog (`availableProducts`,
// from the campaign options endpoint), never duplicated onto the campaign.
// Mirrors CMS's FeaturedProductsSelector pattern (add / remove / reorder).
export function CampaignFeaturedProductsSelector({
  value,
  onChange,
  availableProducts,
  currentlySelected,
}: {
  value: string[];
  onChange: (productIds: string[]) => void;
  availableProducts: SelectableProduct[];
  // Products already on the campaign that may no longer be in
  // `availableProducts` (e.g. now inactive) — kept so a selected-but-now-
  // inactive product still displays a name instead of "Unknown product".
  currentlySelected: SelectableProduct[];
}) {
  const [pendingId, setPendingId] = useState("");
  const byId = new Map(
    [...availableProducts, ...currentlySelected].map((product) => [
      product.id,
      product,
    ]),
  );
  const selectable = availableProducts.filter(
    (product) => product.isActive && !value.includes(product.id),
  );

  function add() {
    if (!pendingId || value.length >= CAMPAIGN_FEATURED_PRODUCTS_MAX) {
      return;
    }
    onChange([...value, pendingId]);
    setPendingId("");
  }

  function remove(id: string) {
    onChange(value.filter((productId) => productId !== id));
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...value];
    const target = index + direction;
    if (target < 0 || target >= next.length) {
      return;
    }
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          No products selected yet.
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {value.map((id, index) => {
            const product = byId.get(id);
            return (
              <li key={id}>
                <Card className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {product ? product.name : `Unknown product (${id})`}
                    </span>
                    {product ? (
                      <span className="truncate text-xs text-text-secondary">
                        {product.category.name}
                        {!product.isActive ? " · inactive" : ""}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      className="px-2"
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => move(index, 1)}
                      disabled={index === value.length - 1}
                      className="px-2"
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => remove(id)}
                    >
                      Remove
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {value.length < CAMPAIGN_FEATURED_PRODUCTS_MAX ? (
        <div className="flex items-center gap-2">
          <select
            value={pendingId}
            onChange={(e) => setPendingId(e.target.value)}
            className={ADMIN_FIELD_CLASS}
          >
            <option value="">Choose a product to add…</option>
            {selectable.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name} — {product.category.name}
              </option>
            ))}
          </select>
          <Button type="button" variant="secondary" onClick={add} disabled={!pendingId}>
            Add
          </Button>
        </div>
      ) : (
        <p className="text-xs text-text-muted">
          Maximum of {CAMPAIGN_FEATURED_PRODUCTS_MAX} products reached.
        </p>
      )}
    </div>
  );
}
