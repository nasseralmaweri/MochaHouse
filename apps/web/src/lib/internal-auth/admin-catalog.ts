import "server-only";
import type {
  AdminCategorySummary,
  AdminLocationMenuResponse,
  AdminMenuDetail,
  AdminMenuSummary,
  AdminModifierGroupDetail,
  AdminModifierGroupSummary,
  AdminProductDetail,
  AdminProductModifiersResponse,
  AdminProductSummary,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";
import { internalAuthHeaders } from "./active-business";

// Server-only reads of the authorized Admin catalog API (Milestone 5D-3).
// Attaches the internal bearer token server-side; distinguishes the failure
// modes the Admin pages care about. Mirrors lib/internal-auth/admin-orders
// and admin-locations. The API (`/api/v1/admin/catalog/products*`,
// InternalAuthGuard + PermissionGuard + `catalog.view`, CORPORATE-only) is
// the sole authorization authority.
function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type AdminProductsListResult =
  | { outcome: "success"; products: AdminProductSummary[] }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "error" };

export async function getAdminProducts(): Promise<AdminProductsListResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/catalog/products`, {
      headers: await internalAuthHeaders(token),
      cache: "no-store",
    });
  } catch {
    return { outcome: "error" };
  }

  if (response.status === 401) {
    return { outcome: "unauthenticated" };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return {
    outcome: "success",
    products: (await response.json()) as AdminProductSummary[],
  };
}

export type AdminProductDetailResult =
  | { outcome: "success"; product: AdminProductDetail }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "error" };

export async function getAdminProduct(
  productId: string,
): Promise<AdminProductDetailResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/admin/catalog/products/${encodeURIComponent(productId)}`,
      {
        headers: await internalAuthHeaders(token),
        cache: "no-store",
      },
    );
  } catch {
    return { outcome: "error" };
  }

  if (response.status === 401) {
    return { outcome: "unauthenticated" };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return {
    outcome: "success",
    product: (await response.json()) as AdminProductDetail,
  };
}

// --- Admin menus & location pricing (Milestone 5D-4) ---------------
// Shared read helper for the 5D-4 endpoints — same server-side token
// attachment and outcome mapping as above, one place.
type AdminReadResult<T> =
  | { outcome: "success"; data: T }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "error" };

async function adminCatalogGet<T>(
  path: string,
): Promise<AdminReadResult<T>> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}${path}`, {
      headers: await internalAuthHeaders(token),
      cache: "no-store",
    });
  } catch {
    return { outcome: "error" };
  }

  if (response.status === 401) {
    return { outcome: "unauthenticated" };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return { outcome: "success", data: (await response.json()) as T };
}

// S1 — every category of the business, inactive included (the "New
// product" form picks one). `catalog.view`, CORPORATE-only.
export function getAdminCategories(): Promise<
  AdminReadResult<AdminCategorySummary[]>
> {
  return adminCatalogGet<AdminCategorySummary[]>("/admin/catalog/categories");
}

export function getAdminMenus(): Promise<AdminReadResult<AdminMenuSummary[]>> {
  return adminCatalogGet<AdminMenuSummary[]>("/admin/catalog/menus");
}

export function getAdminMenu(
  menuId: string,
): Promise<AdminReadResult<AdminMenuDetail>> {
  return adminCatalogGet<AdminMenuDetail>(
    `/admin/catalog/menus/${encodeURIComponent(menuId)}`,
  );
}

// Resolves the location's assigned menu and its per-product price /
// availability. Guarded by `catalog.overrides.manage` (CORPORATE or
// LOCATION) — a location manager reaches this WITHOUT `catalog.view`.
export function getAdminLocationMenu(
  locationId: string,
): Promise<AdminReadResult<AdminLocationMenuResponse>> {
  return adminCatalogGet<AdminLocationMenuResponse>(
    `/admin/catalog/locations/${encodeURIComponent(locationId)}/menu`,
  );
}

// --- Product Modifier Management ------------------------------------
// The business's modifier groups (inactive included), one group with its
// options and the products using it, and one product's groups.
// `catalog.view`, CORPORATE-only.
export function getAdminModifierGroups(): Promise<
  AdminReadResult<AdminModifierGroupSummary[]>
> {
  return adminCatalogGet<AdminModifierGroupSummary[]>(
    "/admin/catalog/modifier-groups",
  );
}

export function getAdminModifierGroup(
  groupId: string,
): Promise<AdminReadResult<AdminModifierGroupDetail>> {
  return adminCatalogGet<AdminModifierGroupDetail>(
    `/admin/catalog/modifier-groups/${encodeURIComponent(groupId)}`,
  );
}

export function getAdminProductModifiers(
  productId: string,
): Promise<AdminReadResult<AdminProductModifiersResponse>> {
  return adminCatalogGet<AdminProductModifiersResponse>(
    `/admin/catalog/products/${encodeURIComponent(productId)}/modifier-groups`,
  );
}
