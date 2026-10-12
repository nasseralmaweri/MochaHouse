import type { AdminProductSummary } from "@mocha-house/contracts";
import {
  buildCreateCategoryRequest,
  buildCreateProductRequest,
  productsNotOnMenu,
  suggestedSlug,
} from "./catalog-create";

const productForm = {
  name: "  Honey Latte ",
  categoryId: "cat-1",
  description: "  Oat milk and honey. ",
  price: "5.25",
  isActive: true,
  slug: "",
};

describe("suggestedSlug", () => {
  it.each([
    ["Honey Latte", "honey-latte"],
    ["Crème Brûlée Latte!", "creme-brulee-latte"],
    ["  --Iced  & Cold--  ", "iced-cold"],
    ["☕☕", ""],
  ])("%j → %j", (name, slug) => {
    expect(suggestedSlug(name)).toBe(slug);
  });
});

describe("buildCreateCategoryRequest", () => {
  it("trims the name and sends a blank slug as null", () => {
    expect(
      buildCreateCategoryRequest({
        name: " Pastries ",
        slug: " ",
        isActive: true,
      }),
    ).toEqual({
      ok: true,
      request: { name: "Pastries", slug: null, isActive: true },
    });
  });

  it.each([
    [{ name: "", slug: "", isActive: true }, "Enter a category name."],
    [{ name: "x".repeat(121), slug: "", isActive: true }, "Keep the name"],
    [{ name: "Ok", slug: "Bad Slug", isActive: true }, "lower-case"],
  ])("rejects %j", (form, message) => {
    const result = buildCreateCategoryRequest(form);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain(message);
  });
});

describe("buildCreateProductRequest", () => {
  it("builds a trimmed request with integer cents", () => {
    expect(buildCreateProductRequest(productForm)).toEqual({
      ok: true,
      request: {
        name: "Honey Latte",
        categoryId: "cat-1",
        description: "Oat milk and honey.",
        basePrice: 525,
        isActive: true,
        slug: null,
      },
    });
  });

  it("treats a blank price as no standard price and a blank description as null", () => {
    const result = buildCreateProductRequest({
      ...productForm,
      price: " ",
      description: "",
      slug: "honey-latte",
    });
    expect(result).toMatchObject({
      ok: true,
      request: { basePrice: null, description: null, slug: "honey-latte" },
    });
  });

  it.each([
    [{ name: " " }, "Enter a product name."],
    [{ categoryId: "" }, "Choose a category."],
    [{ price: "4.555" }, "Enter an amount"],
    [{ price: "-1" }, "Enter an amount"],
    [{ price: "1000.01" }, "at most $1000"],
    [{ description: "x".repeat(1001) }, "description"],
    [{ slug: "a--b" }, "lower-case"],
  ])("rejects %j", (overrides, message) => {
    const result = buildCreateProductRequest({ ...productForm, ...overrides });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain(message);
  });

  it("accepts the maximum price", () => {
    expect(
      buildCreateProductRequest({ ...productForm, price: "1000" }),
    ).toMatchObject({ ok: true, request: { basePrice: 100_000 } });
  });
});

describe("productsNotOnMenu", () => {
  const product = (id: string, name: string): AdminProductSummary => ({
    id,
    name,
    slug: id,
    description: null,
    basePrice: 100,
    currency: "USD",
    isActive: true,
    category: { id: "c", name: "C" },
  });

  it("drops products already on the menu and sorts by name", () => {
    const result = productsNotOnMenu(
      [product("b", "Mocha"), product("a", "Americano"), product("c", "Chai")],
      {
        products: [
          {
            productId: "c",
            productName: "Chai",
            productIsActive: true,
            categoryName: "C",
            standardPrice: 100,
            currency: "USD",
            shownOnMenu: true,
            displayOrder: 1,
          },
        ],
      },
    );
    expect(result.map((p) => p.id)).toEqual(["a", "b"]);
  });
});
