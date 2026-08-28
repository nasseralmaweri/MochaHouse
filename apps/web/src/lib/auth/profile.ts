import "server-only";
import type {
  CustomerProfile,
  CustomerUpdateProfileRequest,
} from "@mocha-house/contracts";

// The "server-only" import makes it a build error for any Client Component
// to import this module: it attaches the raw bearer token to an outgoing
// request and reads the server-only API_URL, neither of which may ever end
// up in a browser bundle. Mirrors lib/auth/orders.ts.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;

  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }

  return apiUrl;
}

export type UpdateProfileResult =
  | { outcome: "success"; profile: CustomerProfile }
  | { outcome: "unauthorized" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error" };

export async function updateCustomerProfile(
  token: string,
  input: CustomerUpdateProfileRequest,
): Promise<UpdateProfileResult> {
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/customers/me`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
      cache: "no-store",
    });
  } catch {
    return { outcome: "error" };
  }

  if (response.status === 401) {
    return { outcome: "unauthorized" };
  }
  if (response.status === 400) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    // The API's 400 messages for this endpoint are already written to be
    // customer-safe (see CustomersService.normalizeDisplayName).
    return {
      outcome: "invalid",
      message: body?.message ?? "That value can't be saved. Please adjust it.",
    };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return {
    outcome: "success",
    profile: (await response.json()) as CustomerProfile,
  };
}
