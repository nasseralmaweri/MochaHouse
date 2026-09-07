import Link from "next/link";
import { redirect } from "next/navigation";
import type { CustomerAccountStatus } from "@mocha-house/contracts";
import { getCustomerSession, getCustomerSessionToken } from "@/lib/auth/session";
import { getCustomerLoyalty } from "@/lib/auth/loyalty";
import { signOutAction } from "@/lib/auth/actions";
import { formatPrice } from "@/lib/money";
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
// Mocha Beans balance; Milestone 7B adds the (display-only) Rewards
// Catalog. Bean history and redemption remain out of scope.
export default async function AccountPage() {
  const session = await getCustomerSession();
  if (!session) {
    redirect("/account/sign-in");
  }

  // Loyalty is a nice-to-have on this page — if the read fails for any
  // reason the rest of the account still renders.
  const token = await getCustomerSessionToken();
  const loyalty = token ? await getCustomerLoyalty(token) : null;
  const summary = loyalty?.outcome === "success" ? loyalty.summary : null;
  const mochaBeans = summary?.balance ?? null;
  const rewards = summary?.rewards ?? [];

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
            Earn Mocha Beans on qualifying purchases.
          </span>
        </div>
        <span className="text-2xl font-semibold tracking-tight text-text-primary">
          {mochaBeans ?? "—"}
        </span>
      </Card>

      {rewards.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold text-text-primary">
            Available Rewards
          </h2>
          <ul className="flex flex-col gap-2">
            {rewards.map((reward) => (
              <li key={reward.id}>
                <Card className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-semibold text-text-primary">
                      {reward.name}
                    </span>
                    {reward.description ? (
                      <span className="text-xs text-text-secondary">
                        {reward.description}
                      </span>
                    ) : reward.type === "FIXED_AMOUNT" &&
                      reward.fixedAmountMinorUnits !== null ? (
                      <span className="text-xs text-text-secondary">
                        {formatPrice(reward.fixedAmountMinorUnits, "USD")} off
                      </span>
                    ) : reward.eligibleItemNames.length > 0 ? (
                      <span className="text-xs text-text-secondary">
                        {reward.eligibleItemNames.join(", ")}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <span className="text-sm font-medium text-text-primary">
                      {reward.beanCost} Beans
                    </span>
                    {mochaBeans !== null ? (
                      <span className="text-xs text-text-muted">
                        {reward.canAfford
                          ? "You have enough"
                          : `${reward.beanCost - mochaBeans} more to go`}
                      </span>
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
