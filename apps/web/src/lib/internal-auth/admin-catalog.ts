import "server-only";
import type {
  AdminProductDetail,
  AdminProductSummary,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

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
      headers: { Authorization: `Bearer ${token}` },
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
        headers: { Authorization: `Bearer ${token}` },
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
