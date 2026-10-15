import "server-only";
import type { NotificationHealthResponse } from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";
import { internalAuthHeaders } from "./active-business";

// Server-only read of the notification health summary (R1 / S4c). The API
// (`GET /api/v1/admin/notifications/health`, InternalAuthGuard +
// PermissionGuard + `notifications.routing.view`, CORPORATE-only, scoped to the
// active business) is the sole authority — this helper never queries Prisma and
// never logs the response.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type NotificationHealthResult =
  | { outcome: "success"; data: NotificationHealthResponse }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "error" };

export async function getAdminNotificationHealth(): Promise<NotificationHealthResult> {
  const token = await getInternalSessionToken();
  if (!token) return { outcome: "unauthenticated" };
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/notifications/health`, {
      headers: await internalAuthHeaders(token),
      cache: "no-store",
    });
  } catch {
    return { outcome: "error" };
  }
  if (response.status === 401) return { outcome: "unauthenticated" };
  if (response.status === 403) return { outcome: "forbidden" };
  if (!response.ok) return { outcome: "error" };
  try {
    return {
      outcome: "success",
      data: (await response.json()) as NotificationHealthResponse,
    };
  } catch {
    return { outcome: "error" };
  }
}
