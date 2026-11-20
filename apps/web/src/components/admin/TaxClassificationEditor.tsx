"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AdminTaxCategory,
  AdminTaxClass,
  AdminTaxProduct,
} from "@mocha-house/contracts";
import {
  setCategoryTaxClass,
  setProductTaxClass,
} from "@/lib/admin/tax-client";
import { classNameOf } from "@/lib/admin/tax";
import { ADMIN_FIELD_CLASS } from "./form";
import { Button } from "./Button";
import { StatusBadge } from "./StatusBadge";
import { Card } from "@/components/Card";

// V1 Sales Tax PR 1 — each category's tax class, explicitly reviewed by the
// administrator (existing categories start as Prepared Food, unreviewed),
// and optional per-product overrides.
export function TaxClassificationEditor({
  classes,
  categories,
  products,
}: {
  classes: AdminTaxClass[];
  categories: AdminTaxCategory[];
  products: AdminTaxProduct[];
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(categories.map((c) => [c.id, c.taxClassId])),
  );
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function review(category: AdminTaxCategory) {
    setError(null);
    setBusy(category.id);
    const result = await setCategoryTaxClass(category.id, choice[category.id]!);
    setBusy(null);
    if (result.outcome === "success") router.refresh();
    else setError(`${category.name}: ${result.message}`);
  }

  async function override(product: AdminTaxProduct, value: string) {
    setError(null);
    setBusy(product.id);
    const result = await setProductTaxClass(product.id, value || null);
    setBusy(null);
    if (result.outcome === "success") router.refresh();
    else setError(`${product.name}: ${result.message}`);
  }

  if (categories.length === 0) {
    return (
      <Card>
        <p className="text-sm text-text-secondary">
          No categories yet. Categories you add appear here to classify.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}
      {categories.map((category) => {
        const items = products.filter((p) => p.categoryId === category.id);
        const changed = choice[category.id] !== category.taxClassId;
        return (
          <Card key={category.id} className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-text-primary">
                  {category.name}
                </span>
                {category.reviewed ? (
                  <StatusBadge label="Reviewed" tone="positive" />
                ) : (
                  <StatusBadge label="Needs review" tone="warning" />
                )}
                {!category.isActive ? <StatusBadge label="Inactive" /> : null}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <label className="sr-only" htmlFor={`category-${category.id}`}>
                  Tax class for {category.name}
                </label>
                <select
                  id={`category-${category.id}`}
                  value={choice[category.id]}
                  onChange={(event) =>
                    setChoice({ ...choice, [category.id]: event.target.value })
                  }
                  className={ADMIN_FIELD_CLASS}
                >
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <Button
                  variant={category.reviewed && !changed ? "secondary" : "primary"}
                  disabled={busy !== null || (category.reviewed && !changed)}
                  onClick={() => void review(category)}
                >
                  {category.reviewed ? "Save" : "Confirm class"}
                </Button>
              </div>
            </div>
            {items.length > 0 ? (
              <div className="border-t border-border-default pt-3">
                <button
                  type="button"
                  aria-expanded={open === category.id}
                  onClick={() => setOpen(open === category.id ? null : category.id)}
                  className="text-sm font-medium text-accent underline-offset-2 hover:underline"
                >
                  {open === category.id ? "Hide" : "Show"} {items.length} product
                  {items.length === 1 ? "" : "s"}
                  {items.some((p) => p.overrideTaxClassId)
                    ? ` (${items.filter((p) => p.overrideTaxClassId).length} with their own class)`
                    : ""}
                </button>
                {open === category.id ? (
                  <ul className="mt-3 flex flex-col gap-2">
                    {items.map((product) => (
                      <li
                        key={product.id}
                        className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <span className="text-sm text-text-primary">
                          {product.name}
                          {!product.isActive ? " (inactive)" : ""}
                        </span>
                        <label className="sr-only" htmlFor={`product-${product.id}`}>
                          Tax class for {product.name}
                        </label>
                        <select
                          id={`product-${product.id}`}
                          value={product.overrideTaxClassId ?? ""}
                          disabled={busy !== null}
                          onChange={(event) => void override(product, event.target.value)}
                          className={ADMIN_FIELD_CLASS}
                        >
                          <option value="">
                            Same as category ({classNameOf(classes, category.taxClassId)})
                          </option>
                          {classes.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
