import "server-only";
import type {
  AdminAccessAssignmentOptions,
  AdminInternalUserDetail,
  AdminInternalUserSummary,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the authorized Admin internal-users API
// (Milestone 5E-1). Attaches the internal bearer token server-side; maps
// the failure modes the Administration screens care about. Mirrors
// lib/internal-auth/admin-catalog.ts. The API (`/api/v1/admin/internal-users*`,
// InternalAuthGuard + PermissionGuard + `users.view`, CORPORATE-only) is
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

type AdminReadResult<T> =
  | { outcome: "success"; data: T }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "error" };

async function adminUsersGet<T>(path: string): Promise<AdminReadResult<T>> {
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

export function getAdminUsers(): Promise<
  AdminReadResult<AdminInternalUserSummary[]>
> {
  return adminUsersGet<AdminInternalUserSummary[]>("/admin/internal-users");
}

export function getAdminUser(
  internalUserId: string,
): Promise<AdminReadResult<AdminInternalUserDetail>> {
  return adminUsersGet<AdminInternalUserDetail>(
    `/admin/internal-users/${encodeURIComponent(internalUserId)}`,
  );
}

// The access-assignment picker data (Milestone 5E-4). Gated server-side by
// `users.manage_roles`; a viewer without it gets `forbidden` and the page
// simply omits the assignment controls.
export function getAdminAccessOptions(): Promise<
  AdminReadResult<AdminAccessAssignmentOptions>
> {
  return adminUsersGet<AdminAccessAssignmentOptions>(
    "/admin/internal-users/access-options",
  );
}
