import { redirect } from "next/navigation";
import Link from "next/link";
import { getInternalSession } from "@/lib/internal-auth/session";
import { can } from "@/lib/admin/capabilities";
import { getAdminPaymentAccount } from "@/lib/internal-auth/admin-payments";
import {
  PAYMENT_ACCOUNT_LABELS,
  PAYMENTS_MESSAGES,
  canContinueSetup,
  connectReturn,
  paymentAccountDescription,
} from "@/lib/admin/payments";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { Card } from "@/components/Card";
import { ConnectPaymentsForm } from "./ConnectPaymentsForm";

// ESP-04 M1 — Admin > Payments: connect the restaurant's OWN Stripe account
// for customer payments (owner only). Returning from Stripe proves nothing:
// the page always reads the account back from Stripe. Customer payments are
// not switched on in this milestone.
export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ connect?: string }>;
}) {
  const session = await getInternalSession();
  if (!session) redirect("/internal/sign-in");
  const header = (
    <AdminPageHeader
      title="Payments"
      description="Your restaurant's own Stripe account for your customers' payments. Your CENTERIVO subscription is under Billing."
    />
  );
  if (!can(session.authorization.capabilities, "payments.connect")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const params = await searchParams;
  const returned = connectReturn(params.connect);
  // Back from Stripe (or asked to): read the account back from Stripe now.
  const result = await getAdminPaymentAccount({ refresh: returned !== null });
  if (result.outcome === "unauthenticated") redirect("/internal/sign-in");
  if (result.outcome !== "success") {
    return (
      <AdminPage>
        {header}
        {result.outcome === "forbidden" ? (
          <AdminForbidden description={PAYMENTS_MESSAGES.ownerOnly} />
        ) : (
          <AdminErrorState description="We couldn't load your payment account just now. Please try again." />
        )}
      </AdminPage>
    );
  }

  const account = result.data;
  const checked = account.lastCheckedAt
    ? new Date(account.lastCheckedAt).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  return (
    <AdminPage>
      {header}
      {returned === "refresh" ? (
        <p
          role="status"
          className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary"
        >
          That Stripe setup link expired. Continue setup to get a new one —
          nothing was lost.
        </p>
      ) : null}
      {!account.providerAvailable ? (
        <p
          role="status"
          className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary"
        >
          {PAYMENTS_MESSAGES.unavailable}
        </p>
      ) : null}
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-text-primary">
            {PAYMENT_ACCOUNT_LABELS[account.state]}
            {account.testMode ? (
              <span className="ml-2 rounded bg-surface-subtle px-2 py-0.5 text-xs font-medium text-text-secondary">
                Test mode
              </span>
            ) : null}
          </h2>
          <p className="text-sm text-text-secondary">
            {paymentAccountDescription(account.state, account.requirementsDue)}
          </p>
        </div>
        {account.accountId ? (
          <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
            <dt className="text-text-secondary">Stripe account</dt>
            <dd className="font-mono text-text-primary">{account.accountId}</dd>
            {checked ? (
              <>
                <dt className="text-text-secondary">
                  Last checked with Stripe
                </dt>
                <dd className="text-text-primary">{checked}</dd>
              </>
            ) : null}
            <dt className="text-text-secondary">Online customer payments</dt>
            <dd className="text-text-primary">Not switched on yet</dd>
          </dl>
        ) : null}
        {account.providerAvailable && canContinueSetup(account.state) ? (
          <ConnectPaymentsForm
            label={
              account.state === "NOT_CONNECTED"
                ? "Connect with Stripe"
                : "Continue setup"
            }
          />
        ) : null}
        {account.providerAvailable && account.accountId ? (
          <Link
            href="/admin/payments?connect=return"
            className="text-sm font-medium text-accent underline-offset-2 hover:underline"
          >
            Check status with Stripe
          </Link>
        ) : null}
      </Card>
    </AdminPage>
  );
}
