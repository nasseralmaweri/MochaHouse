import Link from "next/link";
import { redirect } from "next/navigation";
import type { CustomerAccountStatus } from "@mocha-house/contracts";
import { getCustomerSession, getCustomerSessionToken } from "@/lib/auth/session";
import { getCustomerLoyalty } from "@/lib/auth/loyalty";
import { signOutAction } from "@/lib/auth/actions";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";

const STATUS_LABEL: Record<CustomerAccountStatus, string> = {
  ACTIVE: "Active",
  RESTRICTED: "Restricted",
  DEACTIVATED: "Deactivated",
};

// Account Home: proves the authenticated customer identity is being
// resolved from the API (GET /customers/me), and links to profile
// (Milestone 4E), preferred locations + communication preferences
// (Milestone 4F), and order history (Milestone 4B). Milestone 7A adds the
// Mocha Beans balance. Rewards, Bean history, favorites, etc. remain out of
// scope.
export default async function AccountPage() {
  const session = await getCustomerSession();
  if (!session) {
    redirect("/account/sign-in");
  }

  // The balance is a nice-to-have on this page — if the loyalty read fails
  // for any reason the rest of the account still renders.
  const token = await getCustomerSessionToken();
  const loyalty = token ? await getCustomerLoyalty(token) : null;
  const mochaBeans =
    loyalty?.outcome === "success" ? loyalty.summary.balance : null;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Account"
        subtitle={session.displayName ?? session.email ?? undefined}
      />

      <Card className="flex flex-col gap-2 text-sm text-text-secondary">
        <div className="flex items-center justify-between gap-4">
          <span>Email</span>
          <span className="text-text-primary">{session.email ?? "—"}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span>Status</span>
          <span className="text-text-primary">{STATUS_LABEL[session.status]}</span>
        </div>
      </Card>

      <Card tone="subtle" className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-base font-semibold text-text-primary">
            Mocha Beans
          </span>
          <span className="text-sm text-text-secondary">
            Earn 1 Bean for every $1 you spend.
          </span>
        </div>
        <span className="text-2xl font-semibold tracking-tight text-text-primary">
          {mochaBeans ?? "—"}
        </span>
      </Card>

      <Link
        href="/account/profile"
        className="flex min-h-11 items-center justify-between rounded-xl border border-border-default bg-surface-card px-4 py-3 text-base font-medium text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        Profile
        <span aria-hidden="true">→</span>
      </Link>

      <Link
        href="/account/locations"
        className="flex min-h-11 items-center justify-between rounded-xl border border-border-default bg-surface-card px-4 py-3 text-base font-medium text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        Preferred locations
        <span aria-hidden="true">→</span>
      </Link>

      <Link
        href="/account/preferences"
        className="flex min-h-11 items-center justify-between rounded-xl border border-border-default bg-surface-card px-4 py-3 text-base font-medium text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        Preferences
        <span aria-hidden="true">→</span>
      </Link>

      <Link
        href="/account/orders"
        className="flex min-h-11 items-center justify-between rounded-xl border border-border-default bg-surface-card px-4 py-3 text-base font-medium text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        My orders
        <span aria-hidden="true">→</span>
      </Link>

      <form action={signOutAction}>
        <button
          type="submit"
          className="flex min-h-11 w-full items-center justify-center rounded-xl border border-border-default px-4 py-3 text-base font-semibold text-text-primary"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
