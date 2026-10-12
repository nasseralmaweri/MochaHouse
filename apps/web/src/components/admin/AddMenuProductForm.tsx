"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminProductSummary } from "@mocha-house/contracts";
import { addProductToMenuFromBrowser } from "@/lib/api-client";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS, FormField } from "./form";

// "Add a product" to this menu (S1). The product is added at the end of
// the menu and hidden unless "Show it on the menu now" is ticked — showing
// it later is the existing "Shown on menu" control. Adding a product that
// is already there is harmless (the API is idempotent).
export function AddMenuProductForm({
  menuId,
  products,
}: {
  menuId: string;
  products: AdminProductSummary[];
}) {
  const router = useRouter();
  const [productId, setProductId] = useState("");
  const [showNow, setShowNow] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (productId === "") {
      setError("Choose a product to add.");
      return;
    }
    setPending(true);
    setError(null);
    setMessage(null);
    const result = await addProductToMenuFromBrowser(menuId, {
      productId,
      isActive: showNow,
    });
    setPending(false);

    if (result.outcome === "success") {
      const name = products.find((p) => p.id === productId)?.name ?? "Product";
      setMessage(
        !result.data.created
          ? `${name} is already on this menu.`
          : result.data.placement.isActive
            ? `${name} was added and is shown on the menu.`
            : `${name} was added. Turn on "Shown on menu" when it's ready.`,
      );
      setProductId("");
      setShowNow(false);
      router.refresh();
      return;
    }
    if (result.outcome === "forbidden") {
      setError("You don't have permission to change this menu.");
    } else if (result.outcome === "not-found") {
      setError("This menu no longer exists.");
    } else {
      setError(result.message);
    }
  }

  if (products.length === 0) {
    return (
      <p className="text-sm text-text-secondary">
        Every product is already on this menu.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-lg flex-col gap-4">
      <FormField label="Product" htmlFor="add-menu-product">
        <select
          id="add-menu-product"
          value={productId}
          onChange={(event) => {
            setProductId(event.target.value);
            setError(null);
            setMessage(null);
          }}
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
        >
          <option value="">Choose a product</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.isActive ? product.name : `${product.name} (inactive)`}
            </option>
          ))}
        </select>
      </FormField>

      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input
          type="checkbox"
          checked={showNow}
          onChange={(event) => setShowNow(event.target.checked)}
        />
        Show it on the menu now
      </label>

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-text-secondary">
          {message}
        </p>
      ) : null}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add to menu"}
        </Button>
      </div>
    </form>
  );
}
