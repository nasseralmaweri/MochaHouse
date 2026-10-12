import {
  CATALOG_DESCRIPTION_MAX_LENGTH,
  CATALOG_MAX_PRICE_MINOR_UNITS,
  CATALOG_NAME_MAX_LENGTH,
  isValidCatalogSlug,
  slugifyCatalogName,
  type AdminCreateCategoryRequest,
  type AdminCreateProductRequest,
  type AdminMenuDetail,
  type AdminProductSummary,
} from "@mocha-house/contracts";
import { parseDollarInput } from "@/lib/money";

// S1 — form → request helpers for the Admin "New category" / "New product"
// forms and the "Add a product" control on a menu. Pure, so the same
// checks the API makes are caught before submit with friendly messages;
// the API remains the authority.

export type BuildResult<T> =
  { ok: true; request: T } | { ok: false; error: string };

export interface CategoryForm {
  name: string;
  slug: string;
  isActive: boolean;
}

export interface ProductForm {
  name: string;
  categoryId: string;
  description: string;
  price: string;
  isActive: boolean;
  slug: string;
}

// What the web address will be if the field is left blank (the server may
// still add -2, -3… if that one is taken).
export function suggestedSlug(name: string): string {
  return slugifyCatalogName(name);
}

export function buildCreateCategoryRequest(
  form: CategoryForm,
): BuildResult<AdminCreateCategoryRequest> {
  const name = checkName(form.name, "category");
  if (!name.ok) return name;
  const slug = checkSlug(form.slug);
  if (!slug.ok) return slug;
  return {
    ok: true,
    request: { name: name.value, slug: slug.value, isActive: form.isActive },
  };
}

export function buildCreateProductRequest(
  form: ProductForm,
): BuildResult<AdminCreateProductRequest> {
  const name = checkName(form.name, "product");
  if (!name.ok) return name;
  if (form.categoryId === "") {
    return { ok: false, error: "Choose a category." };
  }
  const description = form.description.trim();
  if (description.length > CATALOG_DESCRIPTION_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep the description to ${CATALOG_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
    };
  }
  const price = parseDollarInput(form.price);
  if (!price.ok) {
    return { ok: false, error: price.error };
  }
  if (price.cents !== null && price.cents > CATALOG_MAX_PRICE_MINOR_UNITS) {
    return {
      ok: false,
      error: `The standard price can be at most $${CATALOG_MAX_PRICE_MINOR_UNITS / 100}.`,
    };
  }
  const slug = checkSlug(form.slug);
  if (!slug.ok) return slug;
  return {
    ok: true,
    request: {
      name: name.value,
      categoryId: form.categoryId,
      description: description === "" ? null : description,
      basePrice: price.cents,
      isActive: form.isActive,
      slug: slug.value,
    },
  };
}

// Products that can still be added to this menu, by name.
export function productsNotOnMenu(
  products: AdminProductSummary[],
  menu: Pick<AdminMenuDetail, "products">,
): AdminProductSummary[] {
  const placed = new Set(menu.products.map((p) => p.productId));
  return products
    .filter((product) => !placed.has(product.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function checkName(raw: string, noun: string): Checked<string> {
  const name = raw.trim();
  if (name === "") {
    return { ok: false, error: `Enter a ${noun} name.` };
  }
  if (name.length > CATALOG_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep the name to ${CATALOG_NAME_MAX_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true, value: name };
}

function checkSlug(raw: string): Checked<string | null> {
  const slug = raw.trim();
  if (slug === "") {
    return { ok: true, value: null };
  }
  if (!isValidCatalogSlug(slug)) {
    return {
      ok: false,
      error:
        "Use only lower-case letters, numbers and single hyphens in the web address, or leave it blank.",
    };
  }
  return { ok: true, value: slug };
}
