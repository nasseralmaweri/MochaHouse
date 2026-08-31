import "server-only";
import type { AdminAuditEventPage } from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the authorized Admin Activity Log API (Milestone
// 5F). Mirrors lib/internal-auth/admin-users.ts. The API
// (`GET /api/v1/admin/audit`, InternalAuthGuard + PermissionGuard +
// `audit.view`, CORPORATE-only) is the sole authorization authority — this
// helper never queries Prisma and never bypasses the API.
function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type AdminAuditReadResult =
  | { outcome: "success"; data: AdminAuditEventPage }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "invalid" }
  | { outcome: "error" };

// `query` is an already-built query string (leading "?" optional) produced
// by lib/admin/audit-log.ts — this helper does not shape filters itself.
export async function getAdminAuditEvents(
  query: string,
): Promise<AdminAuditReadResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  const suffix = query
    ? query.startsWith("?")
      ? query
      : `?${query}`
    : "";

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/audit${suffix}`, {
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
  if (response.status === 400) {
    return { outcome: "invalid" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return {
    outcome: "success",
    data: (await response.json()) as AdminAuditEventPage,
  };
}
