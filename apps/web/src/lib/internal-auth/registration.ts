import "server-only";

import type { OwnerRegistrationAvailability } from "@mocha-house/contracts";

// SC4a — whether the API offers owner self-service registration, and the
// legal versions to show. The API is the only authority (it refuses every
// registration request while disabled); this only decides what to render.
// Any failure reads as "not available".
export async function getOwnerRegistrationAvailability(): Promise<OwnerRegistrationAvailability> {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) return { enabled: false };
  try {
    const response = await fetch(`${apiUrl}/internal/registration`, {
      cache: "no-store",
    });
    if (!response.ok) return { enabled: false };
    const body = (await response.json()) as OwnerRegistrationAvailability;
    return body.enabled === true ? body : { enabled: false };
  } catch {
    return { enabled: false };
  }
}
