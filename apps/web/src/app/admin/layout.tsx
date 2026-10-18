import { Suspense } from "react";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  getInternalSession,
  getInternalSessionToken,
  ADMIN_LOCATION_COOKIE,
} from "@/lib/internal-auth/session";
import { getAccessibleBusinesses } from "@/lib/internal-auth/active-business";
import { adminNavItems } from "@/lib/admin/nav";
import { can } from "@/lib/admin/capabilities";
import {
  billingNotice,
  isWindDownPath,
  WIND_DOWN_NAV_KEYS,
} from "@/lib/admin/billing";
import { getAdminBilling } from "@/lib/internal-auth/admin-billing";
import { AdminShell } from "@/components/admin/AdminShell";
import { centerivoSans } from "@/components/centerivo/fonts";
import { PointsLabelProvider } from "@/lib/points-label-context";
import { pointsLabelOrDefault } from "@/lib/loyalty-label";

export const metadata: Metadata = {
  title: "CENTERIVO",
  description: "CENTERIVO — the hospitality operating platform.",
};

// The server-side boundary for every /admin page (Milestone 5A + 5C). It
// resolves the internal session AND the 5C authorization summary once
// (React-cached, shared with the page rendered inside), redirects anything
// that is not an ACTIVE internal user to the internal sign-in page — or a
// multi-business user with no active business to the business chooser —
// then renders the shared CENTERIVO shell. All interaction lives in the
// client <AdminShell> island — the layout itself is a server component.
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const cookieStore = await cookies();
  const cookieLocationId =
    cookieStore.get(ADMIN_LOCATION_COOKIE)?.value ?? null;

  const { capabilities, isCorporate, locations } = session.authorization;
  // SC3c-1 — a business suspended for billing: only the wind-down areas.
  // A blocked page is redirected on the server (it never renders), to the
  // first wind-down area this person can reach.
  const windDown = session.business.access === "BILLING_WIND_DOWN";
  if (windDown) {
    const pathname = (await headers()).get("x-admin-pathname");
    if (pathname !== null && !isWindDownPath(pathname)) {
      if (can(capabilities, "orders.view")) redirect("/admin/orders");
      if (can(capabilities, "billing.view")) redirect("/admin/billing");
    }
  }

  const token = await getInternalSessionToken();
  // SC3c-1 — a billing state that needs attention (expired trial in its
  // recovery window, a failed payment in grace), for those who see billing;
  // fetched alongside the business list.
  const [accessible, billing] = await Promise.all([
    token ? getAccessibleBusinesses(token) : Promise.resolve(null),
    !windDown && can(capabilities, "billing.view")
      ? getAdminBilling()
      : Promise.resolve(null),
  ]);
  const notice =
    billing?.outcome === "success" ? billingNotice(billing.data.billing) : null;
  // The businesses this person may switch between. Already fetched (and
  // cached for this render) while resolving the session; `session.business`
  // is the one the API actually activated for this request.
  const businesses =
    accessible?.outcome === "ok" &&
    accessible.businesses.some((b) => b.id === session.business.id)
      ? accessible.businesses
      : [session.business];

  const allNavItems = adminNavItems(capabilities);
  const navItems = windDown
    ? allNavItems.filter((item) => WIND_DOWN_NAV_KEYS.includes(item.key))
    : allNavItems;

  return (
    // `contents` carries the CENTERIVO font variable to the shell without
    // adding a layout box.
    <div className={`${centerivoSans.variable} contents`}>
      {/* <AdminShell> reads useSearchParams() for the current ?location; the
          Suspense boundary keeps that from opting the whole route into CSR. */}
      <Suspense fallback={<div className="centerivo min-h-dvh" />}>
        <AdminShell
          user={session.user}
          business={session.business}
          businesses={businesses}
          capabilities={capabilities}
          isCorporate={isCorporate}
          locations={locations}
          navItems={navItems}
          cookieLocationId={cookieLocationId}
          windDown={windDown}
          notice={notice}
        >
          <PointsLabelProvider label={pointsLabelOrDefault(session.loyaltyPointsLabel)}>
            {children}
          </PointsLabelProvider>
        </AdminShell>
      </Suspense>
    </div>
  );
}
