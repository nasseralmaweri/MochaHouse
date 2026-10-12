"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminCategorySummary } from "@mocha-house/contracts";
import { createProductFromBrowser } from "@/lib/api-client";
import {
  buildCreateProductRequest,
  suggestedSlug,
} from "@/lib/admin/catalog-create";
import { Button, ButtonLink } from "./Button";
import { ADMIN_FIELD_CLASS, ActiveStatusField, FormField } from "./form";

// New product (S1). Mirrors the product edit form (dollars in, integer
// cents to the API) plus a category and an optional web address. Creating
// a product does not put it on any menu — the success page says so and
// points to the menus.
export function ProductCreateForm({
  categories,
  initialCategoryId,
}: {
  categories: AdminCategorySummary[];
  initialCategoryId: string | null;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState(
    initialCategoryId && categories.some((c) => c.id === initialCategoryId)
      ? initialCategoryId
      : "",
  );
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [slug, setSlug] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function clearError() {
    setError(null);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const built = buildCreateProductRequest({
      name,
      categoryId,
      description,
      price,
      isActive,
      slug,
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }

    setPending(true);
    setError(null);
    const result = await createProductFromBrowser(built.request);
    if (result.outcome === "success") {
      router.push(`/admin/menu/products/${result.data.id}?created=1`);
      router.refresh();
      return;
    }

    setPending(false);
    if (result.outcome === "forbidden") {
      setError("You don't have permission to create products.");
    } else if (result.outcome === "not-found") {
      setError("Something went wrong. Please try again.");
    } else {
      setError(result.message);
    }
  }

  const preview = slug.trim() === "" ? suggestedSlug(name) : slug.trim();

  return (
    <form onSubmit={handleSubmit} className="flex max-w-lg flex-col gap-6">
      <FormField label="Product name" htmlFor="product-name">
        <input
          id="product-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            clearError();
          }}
          autoComplete="off"
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
        />
      </FormField>

      <FormField label="Category" htmlFor="product-category">
        <select
          id="product-category"
          value={categoryId}
          onChange={(event) => {
            setCategoryId(event.target.value);
            clearError();
          }}
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
        >
          <option value="">Choose a category</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.isActive
                ? category.name
                : `${category.name} (inactive)`}
            </option>
          ))}
        </select>
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
            clearError();
          }}
          rows={3}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

      <FormField
        label="Standard price"
        htmlFor="product-price"
        hint="In dollars, e.g. 3.50. Leave blank for no standard price (locations then set their own)."
      >
        <input
          id="product-price"
          inputMode="decimal"
          value={price}
          onChange={(event) => {
            setPrice(event.target.value);
            clearError();
          }}
          placeholder="0.00"
          autoComplete="off"
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
        />
      </FormField>

      <FormField
        label="Web address"
        htmlFor="product-slug"
        hint={
          preview
            ? `Optional. Leave blank to use "${preview}". It can't be changed later.`
            : "Optional. Leave blank to generate one from the name. It can't be changed later."
        }
      >
        <input
          id="product-slug"
          value={slug}
          onChange={(event) => {
            setSlug(event.target.value);
            clearError();
          }}
          autoComplete="off"
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
        />
      </FormField>

      <ActiveStatusField
        isActive={isActive}
        onChange={(next) => {
          setIsActive(next);
          clearError();
        }}
        hint="A new product isn't on any menu until you add it to one."
      />

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create product"}
        </Button>
        <ButtonLink href="/admin/menu/products" variant="secondary">
          Cancel
        </ButtonLink>
      </div>
    </form>
  );
}
