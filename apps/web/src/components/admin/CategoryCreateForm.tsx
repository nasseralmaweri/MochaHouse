"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createCategoryFromBrowser } from "@/lib/api-client";
import {
  buildCreateCategoryRequest,
  suggestedSlug,
} from "@/lib/admin/catalog-create";
import { Button, ButtonLink } from "./Button";
import { ADMIN_FIELD_CLASS, ActiveStatusField, FormField } from "./form";

// New category (S1). The web address is generated from the name unless one
// is entered; it can't be changed later. On success the admin goes on to
// add a product to the new category.
export function CategoryCreateForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const built = buildCreateCategoryRequest({ name, slug, isActive });
    if (!built.ok) {
      setError(built.error);
      return;
    }

    setPending(true);
    setError(null);
    const result = await createCategoryFromBrowser(built.request);
    if (result.outcome === "success") {
      router.push(
        `/admin/menu/products/new?categoryId=${encodeURIComponent(result.data.id)}`,
      );
      router.refresh();
      return;
    }

    setPending(false);
    if (result.outcome === "forbidden") {
      setError("You don't have permission to create categories.");
    } else if (result.outcome === "not-found") {
      setError("Something went wrong. Please try again.");
    } else {
      setError(result.message);
    }
  }

  const preview = slug.trim() === "" ? suggestedSlug(name) : slug.trim();

  return (
    <form onSubmit={handleSubmit} className="flex max-w-lg flex-col gap-6">
      <FormField label="Category name" htmlFor="category-name">
        <input
          id="category-name"
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
        label="Web address"
        htmlFor="category-slug"
        hint={
          preview
            ? `Optional. Leave blank to use "${preview}". It can't be changed later.`
            : "Optional. Leave blank to generate one from the name. It can't be changed later."
        }
      >
        <input
          id="category-slug"
          value={slug}
          onChange={(event) => {
            setSlug(event.target.value);
            setError(null);
          }}
          autoComplete="off"
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
        />
      </FormField>

      <ActiveStatusField
        isActive={isActive}
        onChange={(next) => {
          setIsActive(next);
          setError(null);
        }}
        hint="Inactive categories are kept for later and hidden from customers."
      />

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create category"}
        </Button>
        <ButtonLink href="/admin/menu/categories" variant="secondary">
          Cancel
        </ButtonLink>
      </div>
    </form>
  );
}
