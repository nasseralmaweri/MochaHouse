"use client";

import { useState } from "react";
import type { AdminProductSummary } from "@mocha-house/contracts";
import { CMS_FEATURED_PRODUCTS_MAX } from "@mocha-house/contracts";
import { Card } from "@/components/Card";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS } from "./form";

// Admin → Content → Home → Featured Products (Milestone 8F). CMS stores
// ONLY an ordered list of product ids — name/price/category shown here are
// read live from the authoritative Admin catalog (`availableProducts`,
// passed down from the server), never duplicated into CMS content.
export function FeaturedProductsSelector({
  value,
  onChange,
  availableProducts,
}: {
  value: string[];
  onChange: (productIds: string[]) => void;
  availableProducts: AdminProductSummary[];
}) {
  const [pendingId, setPendingId] = useState("");
  const byId = new Map(availableProducts.map((product) => [product.id, product]));
  const selectable = availableProducts.filter(
    (product) => product.isActive && !value.includes(product.id),
  );

  function add() {
    if (!pendingId || value.length >= CMS_FEATURED_PRODUCTS_MAX) {
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

      {value.length < CMS_FEATURED_PRODUCTS_MAX ? (
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
          Maximum of {CMS_FEATURED_PRODUCTS_MAX} products reached.
        </p>
      )}
    </div>
  );
}
