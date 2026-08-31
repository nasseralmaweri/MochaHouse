import "server-only";
import type {
  AdminRoleDetail,
  AdminRoleSummary,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the authorized Admin access-levels API
// (Milestone 5E-2). Mirrors lib/internal-auth/admin-users.ts. The API
// (`/api/v1/admin/internal-roles*`, InternalAuthGuard + PermissionGuard +
// `roles.view`, CORPORATE-only) is the sole authorization authority.
function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

type AdminReadResult<T> =
  | { outcome: "success"; data: T }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "error" };

async function adminRolesGet<T>(path: string): Promise<AdminReadResult<T>> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}${path}`, {
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
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return { outcome: "success", data: (await response.json()) as T };
}

export function getAdminRoles(): Promise<
  AdminReadResult<AdminRoleSummary[]>
> {
  return adminRolesGet<AdminRoleSummary[]>("/admin/internal-roles");
}

export function getAdminRole(
  internalRoleId: string,
): Promise<AdminReadResult<AdminRoleDetail>> {
  return adminRolesGet<AdminRoleDetail>(
    `/admin/internal-roles/${encodeURIComponent(internalRoleId)}`,
  );
}
