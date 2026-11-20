import "server-only";
import type {
  AdminLocationTaxResponse,
  AdminTaxSettingsResponse,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";
import { internalAuthHeaders } from "./active-business";

// V1 Sales Tax PR 1 — server-side reads for Admin > Sales tax. The API is
// the sole authority (InternalAuthGuard + PermissionGuard + tax.manage +
// the business's built-in administrator role).

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type AdminTaxResult<T> =
  | { outcome: "success"; data: T }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "error" };

async function read<T>(path: string): Promise<AdminTaxResult<T>> {
  const token = await getInternalSessionToken();
  if (!token) return { outcome: "unauthenticated" };
  try {
    const response = await fetch(`${getApiUrl()}/admin/tax/${path}`, {
      headers: await internalAuthHeaders(token),
      cache: "no-store",
    });
    if (response.status === 401) return { outcome: "unauthenticated" };
    if (response.status === 403) return { outcome: "forbidden" };
    if (response.status === 404) return { outcome: "not-found" };
    if (!response.ok) return { outcome: "error" };
    return { outcome: "success", data: (await response.json()) as T };
  } catch {
    return { outcome: "error" };
  }
}

export function getAdminTaxSettings() {
  return read<AdminTaxSettingsResponse>("settings");
}

export function getAdminLocationTax(locationId: string) {
  return read<AdminLocationTaxResponse>(
    `locations/${encodeURIComponent(locationId)}`,
  );
}
