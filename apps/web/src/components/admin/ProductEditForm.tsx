"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminProductDetail } from "@mocha-house/contracts";
import { updateProductFromBrowser } from "@/lib/api-client";
import { centsToDollarInput, parseDollarInput } from "@/lib/money";
import { Button, ButtonLink } from "./Button";
import { ADMIN_FIELD_CLASS, ActiveStatusField, FormField } from "./form";

// Edit form for a master product (Milestone 5D-3). Admins work in dollars;
// the value is parsed to integer cents before it reaches the API. Clearing
// the price field means "no standard price" (null), which the backend
// already allows. Deactivating a product removes it from the live menu, so
// that one change asks for a quick inline confirmation first.
export function ProductEditForm({
  product,
}: {
  product: AdminProductDetail;
}) {
  const router = useRouter();
  const detailHref = `/admin/menu/products/${product.id}`;

  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description ?? "");
  const [price, setPrice] = useState(centsToDollarInput(product.basePrice));
  const [isActive, setIsActive] = useState(product.isActive);
  const [pending, setPending] = useState(false);
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const willDeactivate = product.isActive && !isActive;

  async function save(basePrice: number | null) {
    setPending(true);
    setError(null);
    const trimmedDescription = description.trim();
    const result = await updateProductFromBrowser(product.id, {
      name: name.trim(),
      description: trimmedDescription === "" ? null : trimmedDescription,
      basePrice,
      isActive,
    });

    if (result.outcome === "success") {
      router.push(detailHref);
      router.refresh();
      return;
    }

    setPending(false);
    setConfirmingDeactivate(false);
    if (result.outcome === "invalid") {
      setError(result.message);
    } else if (result.outcome === "forbidden") {
      setError("You don't have permission to edit this product.");
    } else if (result.outcome === "not-found") {
      setError("This product no longer exists.");
    } else {
      setError(result.message);
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (name.trim() === "") {
      setError("Enter a product name.");
      return;
    }
    const parsedPrice = parseDollarInput(price);
    if (!parsedPrice.ok) {
      setError(parsedPrice.error);
      return;
    }
    if (willDeactivate && !confirmingDeactivate) {
      setError(null);
      setConfirmingDeactivate(true);
      return;
    }
    void save(parsedPrice.cents);
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-lg flex-col gap-6">
      <FormField label="Product name" htmlFor="product-name">
        <input
          id="product-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          autoComplete="off"
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
        />
      </FormField>

      <FormField
        label="Description"
        htmlFor="product-description"
        hint="Optional. Shown to customers on the menu."
      >
        <textarea
          id="product-description"
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
            setError(null);
          }}
          rows={3}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

      <FormField
        label="Standard price"
        htmlFor="product-price"
        hint="In dollars, e.g. 3.50. Leave blank for no standard price."
      >
        <input
          id="product-price"
          inputMode="decimal"
          value={price}
          onChange={(event) => {
            setPrice(event.target.value);
            setError(null);
          }}
          placeholder="0.00"
          autoComplete="off"
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
        />
      </FormField>

      <ActiveStatusField
        isActive={isActive}
        onChange={(next) => {
          setIsActive(next);
          if (next) {
            setConfirmingDeactivate(false);
          }
          setError(null);
        }}
        hint="Inactive products don't appear on any menu."
      />

      <dl className="flex flex-col gap-1 text-xs text-text-muted">
        <div className="flex gap-2">
          <dt>Category:</dt>
          <dd className="text-text-secondary">{product.category.name}</dd>
        </div>
        <div className="flex gap-2">
          <dt>Web address:</dt>
          <dd className="text-text-secondary">{product.slug}</dd>
        </div>
      </dl>

      {confirmingDeactivate ? (
        <div
          role="alert"
          className="rounded-xl border border-border-default bg-surface-subtle px-3 py-3 text-sm text-text-primary"
        >
          Deactivate this product? Customers won&apos;t see this product on the
          menu.
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending
            ? "Saving…"
            : confirmingDeactivate
              ? "Deactivate and save"
              : "Save changes"}
        </Button>
        <ButtonLink href={detailHref} variant="secondary">
          Cancel
        </ButtonLink>
      </div>
    </form>
  );
}
