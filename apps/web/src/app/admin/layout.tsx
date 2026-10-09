import { Suspense } from "react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getInternalSession,
  getInternalSessionToken,
  ADMIN_LOCATION_COOKIE,
} from "@/lib/internal-auth/session";
import { getAccessibleBusinesses } from "@/lib/internal-auth/active-business";
import { adminNavItems } from "@/lib/admin/nav";
import { AdminShell } from "@/components/admin/AdminShell";
import { centerivoSans } from "@/components/centerivo/fonts";

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

  // The businesses this person may switch between. Already fetched (and
  // cached for this render) while resolving the session; `session.business`
  // is the one the API actually activated for this request.
  const token = await getInternalSessionToken();
  const accessible = token ? await getAccessibleBusinesses(token) : null;
  const businesses =
    accessible?.outcome === "ok" &&
    accessible.businesses.some((b) => b.id === session.business.id)
      ? accessible.businesses
      : [session.business];

  const { capabilities, isCorporate, locations } = session.authorization;
  const navItems = adminNavItems(capabilities);

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
        >
          {children}
        </AdminShell>
      </Suspense>
    </div>
  );
}
