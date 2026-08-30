"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getInternalSession, ADMIN_LOCATION_COOKIE } from "./session";
import { CORPORATE_LOCATION_VALUE } from "@/lib/admin/location-context";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// Persists the Admin location preference cookie. This is a UI convenience,
// not a security boundary — it only affects which context the shell
// *defaults* to. It still re-checks the value against the caller's
// authorized set (from GET /internal/me) so a stale/forged value is simply
// not written; and every Admin API request is independently guarded
// server-side regardless of the cookie.
export async function setAdminLocationPreference(value: string): Promise<void> {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const isValid =
    value === CORPORATE_LOCATION_VALUE
      ? session.authorization.isCorporate
      : session.authorization.locations.some(
          (location) => location.id === value,
        );

  if (!isValid) {
    return;
  }

  const cookieStore = await cookies();
  cookieStore.set(ADMIN_LOCATION_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
}
