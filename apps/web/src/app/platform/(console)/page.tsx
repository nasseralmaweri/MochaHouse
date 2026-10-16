import { redirect } from "next/navigation";
import {
  PlatformCard,
  PlatformEmptyState,
  PlatformPageHeader,
  UnavailableMetric,
} from "@/components/platform/PlatformCards";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { PLATFORM_NAV_ITEMS, isAvailable } from "@/lib/platform/nav";

// SC1b — the platform console's Overview. Only facts that a built API can
// back are shown (the signed-in operator); every SaaS metric whose backend
// does not exist yet says so instead of showing a number.
export default async function PlatformOverviewPage() {
  const session = await getPlatformSession();
  if (session.state !== "signed-in") {
    redirect("/platform/sign-in");
  }
  const { operator } = session;
  const comingSoon = PLATFORM_NAV_ITEMS.filter((item) => !isAvailable(item));

  return (
    <div className="flex flex-col gap-8">
      <PlatformPageHeader
        title="Overview"
        description="The CENTERIVO platform at a glance. Figures appear here as each platform module is built — nothing is estimated."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <UnavailableMetric
          title="Total businesses"
          reason="Arrives with tenant administration."
        />
        <UnavailableMetric
          title="Active businesses"
          reason="Arrives with tenant administration."
        />
        <UnavailableMetric
          title="Active subscriptions"
          reason="Arrives with subscriptions."
        />
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
