"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { AdminProductSummary } from "@mocha-house/contracts";
import { formatPrice } from "@/lib/money";
import { Card } from "@/components/Card";
import { StatusBadge } from "./StatusBadge";
import { ADMIN_FIELD_CLASS } from "./form";

// The product list with a plain name/category search (Milestone 5D-3). The
// list is already fully loaded and authorized server-side; this just filters
// it in the browser — no extra requests, no backend search. Good enough for
// the current catalog size; revisit only if the catalog grows large.
export function ProductsBrowser({
  products,
}: {
  products: AdminProductSummary[];
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") {
      return products;
    }
    return products.filter(
      (product) =>
        product.name.toLowerCase().includes(q) ||
        product.category.name.toLowerCase().includes(q),
    );
  }, [products, query]);

  return (
    <div className="flex flex-col gap-4">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search products"
        aria-label="Search products"
        className={`${ADMIN_FIELD_CLASS} min-h-11`}
      />

      {filtered.length === 0 ? (
        <Card
          tone="subtle"
          className="text-sm text-text-secondary"
        >
          No products match “{query.trim()}”.
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((product) => (
            <li key={product.id}>
              <Link
                href={`/admin/menu/products/${product.id}`}
                className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <Card className="flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-base font-semibold text-text-primary">
                      {product.name}
                    </span>
                    <span aria-hidden="true" className="text-text-muted">
                      →
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
                    <span>{product.category.name}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {product.basePrice === null
                        ? "No standard price"
                        : formatPrice(product.basePrice, product.currency)}
                    </span>
                    <StatusBadge
                      label={product.isActive ? "Active" : "Inactive"}
                      tone={product.isActive ? "positive" : "neutral"}
                    />
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
