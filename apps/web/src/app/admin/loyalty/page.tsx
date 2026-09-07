import Link from "next/link";
import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import {
  getLoyaltyCustomerDetail,
  searchLoyaltyCustomers,
} from "@/lib/internal-auth/admin-loyalty";
import { can } from "@/lib/admin/capabilities";
import { normalizeLoyaltyQuery } from "@/lib/admin/loyalty-adjustment";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { Card } from "@/components/Card";
import { LoyaltyTabs } from "@/components/admin/LoyaltyTabs";
import { MochaBeanAdjustForm } from "@/components/admin/MochaBeanAdjustForm";

// Admin → Loyalty (Milestone 7A). The smallest HQ Mocha Beans surface:
// look a customer up by email or id, read their balance and the internal
// Bean ledger, and manually add/deduct with a required reason. NOT a
// customer-management module. `loyalty.view` (CORPORATE-only) is enforced
// by the API; the check here just keeps the page out of the way for anyone
// who can't use it. The lookup query and the selected customer id live in
// the URL, so the view is refresh-safe and linkable.
export default async function AdminLoyaltyPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string | string[];
    customerId?: string | string[];
  }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Loyalty"
      description="Look up a customer's Mocha Bean balance and ledger, and make a manual adjustment."
      breadcrumbs={[{ label: "Loyalty" }]}
    />
  );

  const caps = session.authorization.capabilities;
  const canViewCustomers = can(caps, "loyalty.view");
  const canConfigure = can(caps, "loyalty.configure");

  if (!canViewCustomers) {
    // A configuration-only HQ user has no customer-lookup access; send them
    // to the part of Loyalty they can use.
    if (canConfigure) {
      redirect("/admin/loyalty/rewards");
    }
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const canAdjust = can(caps, "loyalty.adjust");

  const params = await searchParams;
  const rawQuery = Array.isArray(params.q) ? params.q[0] : params.q;
  const query = normalizeLoyaltyQuery(rawQuery ?? "");
  const selectedId = Array.isArray(params.customerId)
    ? params.customerId[0]
    : params.customerId;

  return (
    <AdminPage>
      {header}

      <LoyaltyTabs
        active="customers"
        canView={canViewCustomers}
        canConfigure={canConfigure}
      />

      <AdminSection
        title="Find a customer"
        description="Enter an exact email address or customer id."
      >
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-sm font-medium text-text-primary">
              Email or customer id
            </span>
            <input
              type="text"
              name="q"
              defaultValue={query}
              autoComplete="off"
              className="rounded-xl border border-border-default bg-surface-card px-3 py-2 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            />
          </label>
          <button
            type="submit"
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-2 text-sm font-semibold text-status-success hover:bg-status-success/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            Search
          </button>
        </form>

        {query.length > 0 ? (
          <SearchResults query={query} selectedId={selectedId} />
        ) : null}
      </AdminSection>

      {selectedId ? (
        <CustomerDetail customerId={selectedId} canAdjust={canAdjust} />
      ) : null}
    </AdminPage>
  );
}

async function SearchResults({
  query,
  selectedId,
}: {
  query: string;
  selectedId?: string;
}) {
  const result = await searchLoyaltyCustomers(query);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return <AdminForbidden />;
  }
  if (result.outcome === "invalid") {
    return (
      <AdminEmptyState
        title="Enter something to search"
        description="Search by exact email address or customer id."
      />
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminErrorState description="Couldn't run that search just now. Please try again." />
    );
  }

  const { customers } = result.data;
  if (customers.length === 0) {
    return (
      <AdminEmptyState
        title="No customer found"
        description="Check the email address or customer id and try again."
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {customers.map((customer) => {
        const isSelected = customer.id === selectedId;
        return (
          <li key={customer.id}>
            <Link
              href={{
                pathname: "/admin/loyalty",
                query: { q: query, customerId: customer.id },
              }}
              aria-current={isSelected ? "true" : undefined}
              className={`flex items-center justify-between gap-4 rounded-xl border border-border-default px-4 py-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                isSelected
                  ? "bg-surface-subtle"
                  : "bg-surface-card hover:bg-surface-subtle"
              }`}
            >
              <span className="flex flex-col">
                <span className="font-medium text-text-primary">
                  {customer.displayName ?? customer.email ?? customer.id}
                </span>
                <span className="text-xs text-text-muted">
                  {customer.email ?? "no email"} · {customer.id}
                </span>
              </span>
              <span className="shrink-0 font-semibold text-text-primary">
                {customer.balance} Beans
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

async function CustomerDetail({
  customerId,
  canAdjust,
}: {
  customerId: string;
  canAdjust: boolean;
}) {
  const result = await getLoyaltyCustomerDetail(customerId);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return <AdminForbidden />;
  }
  if (result.outcome === "not-found") {
    return (
      <AdminNotFound
        title="Customer not found"
        description="This customer no longer exists."
        backHref="/admin/loyalty"
        backLabel="Back to Loyalty"
      />
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminErrorState description="Couldn't load that customer just now. Please try again." />
    );
  }

  const { customer, entries } = result.data;

  return (
    <AdminSection title="Mocha Beans">
      <Card className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-base font-semibold text-text-primary">
            {customer.displayName ?? customer.email ?? customer.id}
          </span>
          <span className="text-xs text-text-muted">
            {customer.email ?? "no email"} · {customer.id}
          </span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-2xl font-semibold tracking-tight text-text-primary">
            {customer.balance}
          </span>
          <span className="text-xs text-text-muted">Mocha Beans</span>
        </div>
      </Card>

      {canAdjust ? (
        <MochaBeanAdjustForm
          customerId={customer.id}
          currentBalance={customer.balance}
        />
      ) : (
        <p className="text-sm text-text-muted">
          You have view-only access to loyalty. Adjusting Mocha Beans requires
          the loyalty adjustment permission.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text-primary">
          Internal Bean ledger
        </h3>
        {entries.length === 0 ? (
          <p className="text-sm text-text-muted">No Bean activity yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border-default text-left text-xs text-text-muted">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Type</th>
                  <th className="py-2 pr-3 text-right font-medium">Amount</th>
                  <th className="py-2 pr-3 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-b border-border-default/60 align-top"
                  >
                    <td className="py-2 pr-3 text-text-secondary">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3 text-text-secondary">
                      {entry.type === "EARN" ? "Earned" : "Manual adjustment"}
                    </td>
                    <td
                      className={`py-2 pr-3 text-right font-medium ${
                        entry.amount < 0
                          ? "text-status-warning"
                          : "text-text-primary"
                      }`}
                    >
                      {entry.amount > 0 ? `+${entry.amount}` : entry.amount}
                    </td>
                    <td className="py-2 pr-3 text-text-secondary">
                      {entry.type === "EARN"
                        ? entry.orderNumber
                          ? `Order #${entry.orderNumber}`
                          : "Order"
                        : `${entry.reason ?? ""}${
                            entry.actorLabel ? ` — ${entry.actorLabel}` : ""
                          }`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminSection>
  );
}
