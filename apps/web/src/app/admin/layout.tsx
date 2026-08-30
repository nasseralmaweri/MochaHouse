import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getInternalSession,
  ADMIN_LOCATION_COOKIE,
} from "@/lib/internal-auth/session";
import { adminNavItems } from "@/lib/admin/nav";
import { AdminShell } from "@/components/admin/AdminShell";

// The server-side boundary for every /admin page (Milestone 5A + 5C). It
// resolves the internal session AND the 5C authorization summary once
// (React-cached, shared with the page rendered inside), redirects anything
// that is not an ACTIVE internal user to the internal sign-in page, then
// renders the shared Admin shell. All interaction lives in the client
// <AdminShell> island — the layout itself is a server component.
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
  const navItems = adminNavItems(capabilities);

  return (
    // <AdminShell> reads useSearchParams() for the current ?location; the
    // Suspense boundary keeps that from opting the whole route into CSR.
    <Suspense fallback={<div className="min-h-dvh bg-surface-page" />}>
      <AdminShell
        user={session.user}
        capabilities={capabilities}
        isCorporate={isCorporate}
        locations={locations}
        navItems={navItems}
        cookieLocationId={cookieLocationId}
      >
        {children}
      </AdminShell>
    </Suspense>
  );
}
