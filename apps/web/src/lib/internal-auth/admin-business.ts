"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ADMIN_BUSINESS_COOKIE,
  getAccessibleBusinesses,
} from "./active-business";
import { getInternalSessionToken, ADMIN_LOCATION_COOKIE } from "./session";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export type SwitchBusinessResult = { error: string } | undefined;

// Selects the active business for the Admin shell (Milestone S0F contract).
// The id is only INTENT: it is checked against the API's own list of
// businesses this identity may enter, and the API re-validates membership on
// every later request. A business that is not in that list (revoked,
// suspended, or never granted) is refused with a message — it is never
// stored.
//
// A successful switch also drops the location preference, because that
// cookie names a location of the PREVIOUS business, and sends the person to
// the new business's dashboard with no ?location carried over.
export async function switchBusinessAction(
  businessId: string,
): Promise<SwitchBusinessResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    redirect("/internal/sign-in");
  }

  const accessible = await getAccessibleBusinesses(token);
  if (accessible.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (accessible.outcome === "error") {
    return { error: "Could not reach the server. Please try again." };
  }
  if (
    accessible.outcome !== "ok" ||
    !accessible.businesses.some((business) => business.id === businessId)
  ) {
    return {
      error: "You no longer have access to that business.",
    };
  }

  const cookieStore = await cookies();
  cookieStore.set(ADMIN_BUSINESS_COOKIE, businessId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
  cookieStore.delete(ADMIN_LOCATION_COOKIE);

  redirect("/admin");
}
