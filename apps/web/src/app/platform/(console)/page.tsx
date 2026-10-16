import Link from "next/link";
import { redirect } from "next/navigation";
import {
  PlatformCard,
  PlatformEmptyState,
  PlatformPageHeader,
  UnavailableMetric,
} from "@/components/platform/PlatformCards";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { PLATFORM_NAV_ITEMS, isAvailable } from "@/lib/platform/nav";
import {
  getPlatformRegistryTotals,
  listPlatformPlans,
} from "@/lib/platform/tenants-api";

function RegistryMetric({ title, value }: { title: string; value: number }) {
  return (
    <PlatformCard title={title}>
      <p className="text-2xl font-semibold text-text-primary">{value}</p>
      <Link
        href="/platform/tenants"
        className="w-fit text-sm font-medium text-text-secondary underline-offset-4 hover:text-text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
      >
        View tenants
      </Link>
    </PlatformCard>
  );
}

// SC1b — the platform console's Overview. Only facts that a built API can
// back are shown (the signed-in operator); every SaaS metric whose backend
// does not exist yet says so instead of showing a number.
// SC1c — business counts now come from the tenant registry (real records);
// if it cannot be read, the cards say so rather than guess.
export default async function PlatformOverviewPage() {
  const session = await getPlatformSession();
  if (session.state !== "signed-in") {
    redirect("/platform/sign-in");
  }
  const { operator } = session;
  const comingSoon = PLATFORM_NAV_ITEMS.filter((item) => !isAvailable(item));
  const [totals, plans] = await Promise.all([
    getPlatformRegistryTotals(),
    listPlatformPlans(),
  ]);
  const registry = totals.state === "ok" ? totals.data.registry : null;

  return (
    <div className="flex flex-col gap-8">
      <PlatformPageHeader
        title="Overview"
        description="The CENTERIVO platform at a glance. Figures appear here as each platform module is built — nothing is estimated."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {registry ? (
          <>
            <RegistryMetric title="Total businesses" value={registry.total} />
            <RegistryMetric title="Active businesses" value={registry.active} />
          </>
        ) : (
          <>
            <UnavailableMetric
              title="Total businesses"
              reason="The tenant registry could not be loaded."
            />
            <UnavailableMetric
              title="Active businesses"
              reason="The tenant registry could not be loaded."
            />
          </>
        )}
        {/* SC2a — businesses with a plan (no billing yet). */}
        {plans.state === "ok" ? (
          <RegistryMetric
            title="Businesses with a plan"
            value={plans.data.subscriptions.total}
          />
        ) : (
          <UnavailableMetric
            title="Businesses with a plan"
            reason="Plans could not be loaded."
          />
        )}
        <UnavailableMetric
          title="Monthly recurring revenue"
          reason="Arrives with SaaS billing."
        />
        <UnavailableMetric
          title="Platform alerts"
          reason="Arrives with platform operations."
        />
        <PlatformCard title="Signed in as">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-text-muted">Name</dt>
            <dd className="truncate text-text-primary">
              {operator.displayName ?? "—"}
            </dd>
            <dt className="text-text-muted">Email</dt>
            <dd className="truncate text-text-primary">{operator.email}</dd>
            <dt className="text-text-muted">Role</dt>
            <dd className="text-text-primary">Platform operator</dd>
          </dl>
        </PlatformCard>
      </div>

      <PlatformEmptyState title="Coming next">
        <ul className="mt-1 flex flex-col gap-1">
          {comingSoon.map((item) => (
            <li key={item.key}>
              <span className="font-medium text-text-primary">{item.label}</span>
              {" — "}
              {item.description}
            </li>
          ))}
        </ul>
      </PlatformEmptyState>
    </div>
  );
}
