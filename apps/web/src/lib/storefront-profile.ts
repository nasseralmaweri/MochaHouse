import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import {
  DEFAULT_LOYALTY_POINTS_LABEL,
  STOREFRONT_NOT_FOUND,
  type StorefrontProfileResponse,
} from "@mocha-house/contracts";
import { storefrontApiFetch, storefrontHostRoutingEnabled } from "@/lib/storefront-context";

// SC4f-3b — the storefront's own business, from the API's resolved business
// (host routing or the deployment's single business; never a browser value).
// React-cached so a layout and the page inside it share one request; never
// stored in a shared cache (storefrontApiFetch disables caching when host
// routing is on, and the API answers no-store).

export type StorefrontProfileResult =
  | { state: "ok"; profile: StorefrontProfileResponse }
  | { state: "not-found" }
  | { state: "unavailable" };

export const getStorefrontProfile = cache(async (): Promise<StorefrontProfileResult> => {
  // Always per request: the profile depends on the address asked for and the
  // business's current state, so no page built from it is ever prerendered.
  await connection();
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error("API_URL environment variable is not set. See apps/web/.env.example.");
  }
  let response: Response;
  try {
    response = await storefrontApiFetch(`${apiUrl}/storefront/profile`, { cache: "no-store" });
  } catch {
    return { state: "unavailable" };
  }
  if (response.status === 404) {
    const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
    if (body?.code === STOREFRONT_NOT_FOUND) return { state: "not-found" };
  }
  if (!response.ok) return { state: "unavailable" };
  try {
    return { state: "ok", profile: (await response.json()) as StorefrontProfileResponse };
  } catch {
    return { state: "unavailable" };
  }
});

// While the API cannot be reached:
//   * host routing OFF — the deployment's single business, which keeps
//     today's legacy presentation; no name is shown and ordering is not
//     offered (checkout is server-checked regardless);
//   * host routing ON — no presentation is guessed: the page fails to the
//     neutral error page (app/error.tsx), never another business's look.
export const UNAVAILABLE_PROFILE: StorefrontProfileResponse = {
  businessName: "",
  orderingAvailable: false,
  loyaltyPointsLabel: DEFAULT_LOYALTY_POINTS_LABEL,
  presentation: "legacy",
};

export class StorefrontUnavailableError extends Error {
  constructor() {
    super("The storefront's business could not be confirmed right now.");
    this.name = "StorefrontUnavailableError";
  }
}

// The profile for a storefront page: an unknown or unpublished storefront
// address is a 404 page; an outage as described above.
export async function requireStorefrontProfile(): Promise<StorefrontProfileResponse> {
  const result = await getStorefrontProfile();
  if (result.state === "not-found") notFound();
  if (result.state === "ok") return result.profile;
  if (storefrontHostRoutingEnabled()) throw new StorefrontUnavailableError();
  return UNAVAILABLE_PROFILE;
}

// "Mocha House", or a neutral phrase when the name is not known.
export function businessNameOr(profile: StorefrontProfileResponse, fallback: string): string {
  return profile.businessName.trim() === "" ? fallback : profile.businessName;
}

// A page title: "Careers · Mocha House", or just "Careers".
export function pageTitle(profile: StorefrontProfileResponse, title?: string): string {
  const name = profile.businessName.trim();
  if (!title) return name === "" ? "Online ordering" : name;
  return name === "" ? title : `${title} · ${name}`;
}

// Wording that names the business: "{name}" replaced by its name, or the
// neutral fallback when the name is not known.
export function named(
  profile: StorefrontProfileResponse,
  template: string,
  fallback: string,
): string {
  const name = profile.businessName.trim();
  return name === "" ? fallback : template.replaceAll("{name}", name);
}
