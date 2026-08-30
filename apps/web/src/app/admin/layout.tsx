import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { internalSignOutAction } from "@/lib/internal-auth/actions";

// The server-side auth boundary for every /admin page (Milestone 5A).
// Rendered on the server before any Admin page, it resolves the internal
// session against the authoritative API (GET /internal/me) — so an expired
// token, or an internal user who is no longer ACTIVE, is turned away here,
// not merely hidden from a nav. Anything but an ACTIVE internal user is
// redirected to the internal sign-in page.
//
// Deliberately minimal: a thin identity strip with a sign-out control, not
// an Admin shell/navigation (that is a later Milestone 5 slice).
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border-default bg-surface-card">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-4 py-3">
          <span className="text-sm text-text-secondary">
            Signed in as{" "}
            <span className="text-text-primary">
              {session.displayName ?? session.email}
            </span>
          </span>
          <form action={internalSignOutAction}>
            <button
              type="submit"
              className="text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
