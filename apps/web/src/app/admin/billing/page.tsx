import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { can } from "@/lib/admin/capabilities";
import { getAdminBilling } from "@/lib/internal-auth/admin-billing";
import {
  BILLING_MESSAGES,
  BILLING_STATE_LABELS,
  billingStateDescription,
  checkoutReturn,
  portalReturn,
} from "@/lib/admin/billing";
import { formatMinorUnits } from "@/lib/admin/crm";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden, AdminNotFound } from "@/components/admin/states";
import { Card } from "@/components/Card";
import { SetUpPaymentForm } from "./SetUpPaymentForm";
import { BillingActionForm } from "./BillingActionForm";
import { CheckoutConfirming } from "./CheckoutConfirming";
import { ForgetCheckoutReturn } from "./ForgetCheckoutReturn";

// SC3b — the business's own CENTERIVO subscription: plan, price and billing
// status, and (owner) payment setup through the provider's hosted Checkout.
// Restaurant customer payments are unrelated and never shown here.
export default async function AdminBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; portal?: string }>;
}) {
  const session = await getInternalSession();
  if (!session) redirect("/internal/sign-in");
  const header = (
    <AdminPageHeader
      title="Billing"
      description="Your CENTERIVO subscription. Payments from your customers are not shown here."
    />
  );
  if (!can(session.authorization.capabilities, "billing.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const [result, params] = await Promise.all([getAdminBilling(), searchParams]);
  if (result.outcome === "unauthenticated") redirect("/internal/sign-in");
  if (result.outcome !== "success") {
    return (
      <AdminPage>
        {header}
        {result.outcome === "forbidden" ? (
          <AdminForbidden />
        ) : result.outcome === "not-found" ? (
          <AdminNotFound title="No subscription yet" />
        ) : (
          <AdminErrorState description="We couldn't load your billing just now. Please try again." />
        )}
      </AdminPage>
    );
  }

  const {
    billing,
    canSetUpPayment,
    canRestartSubscription,
    canPayInvoice,
    canManagePaymentMethod,
  } = result.data;
  const returned = checkoutReturn(params.checkout);
  const fromPortal = portalReturn(params.portal);
  // Back from the provider but not confirmed yet (a new setup, or a restart
  // of an ended subscription): the page re-reads itself and the action is
  // hidden (nothing needs doing again).
  const confirming =
    returned === "success" &&
    (billing.state === "AWAITING_SETUP" ||
      billing.state === "TRIAL_EXPIRED" ||
      billing.state === "CANCELED");
  const date = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-US", { dateStyle: "long" }) : null;

  return (
    <AdminPage>
      {header}
      {(returned && !confirming) || fromPortal ? <ForgetCheckoutReturn /> : null}
      {fromPortal ? (
        <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
          You&apos;re back from our payment provider. Any payment method changes are saved there.
        </p>
      ) : null}
      {confirming ? (
        <CheckoutConfirming />
      ) : returned === "success" ? (
        <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
          Payment setup is complete.
        </p>
      ) : returned === "pending" ? (
        <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
          We haven&apos;t received confirmation of your payment yet. If you completed it, this page
          shows it once it&apos;s confirmed — you don&apos;t need to pay again. Otherwise you can try
          again below.
        </p>
      ) : returned === "cancelled" ? (
        <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
          Payment setup was cancelled. Nothing was charged.
        </p>
      ) : null}
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-text-secondary">Plan</p>
          <p className="text-lg font-semibold text-text-primary">{billing.planName}</p>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-text-secondary">Status</dt>
            <dd className="font-medium text-text-primary">{BILLING_STATE_LABELS[billing.state]}</dd>
          </div>
          {billing.price ? (
            <div>
              <dt className="text-text-secondary">Price</dt>
              <dd className="font-medium text-text-primary">
                {formatMinorUnits(billing.price.amountMinorUnits, billing.price.currency)}
                {billing.price.interval === "MONTH" ? " per month" : " per year"}
              </dd>
            </div>
          ) : null}
          {billing.trialEndsAt && billing.state === "TRIALING" ? (
            <div>
              <dt className="text-text-secondary">Trial ends</dt>
              <dd className="font-medium text-text-primary">{date(billing.trialEndsAt)}</dd>
            </div>
          ) : null}
          {billing.currentPeriodEnd && billing.state !== "COMPLIMENTARY" ? (
            <div>
              <dt className="text-text-secondary">
                {billing.cancelAtPeriodEnd ? "Ends on" : "Renews on"}
              </dt>
              <dd className="font-medium text-text-primary">{date(billing.currentPeriodEnd)}</dd>
            </div>
          ) : null}
          {billing.graceEndsAt && billing.state === "PAST_DUE" ? (
            <div>
              <dt className="text-text-secondary">Payment needed by</dt>
              <dd className="font-medium text-text-primary">{date(billing.graceEndsAt)}</dd>
            </div>
          ) : null}
        </dl>
        <p className="text-sm text-text-primary">{billingStateDescription(billing)}</p>
        {canSetUpPayment && !confirming ? (
          <SetUpPaymentForm />
        ) : billing.state === "AWAITING_SETUP" && !confirming ? (
          <p className="text-sm text-text-secondary">{BILLING_MESSAGES.forbidden}</p>
        ) : null}
        {canRestartSubscription && !confirming ? <BillingActionForm kind="restart" /> : null}
        {canPayInvoice ? <BillingActionForm kind="invoice" /> : null}
        {canManagePaymentMethod && !confirming ? <BillingActionForm kind="portal" /> : null}
        {!canRestartSubscription &&
        !canPayInvoice &&
        ["PAST_DUE", "UNPAID", "TRIAL_EXPIRED", "CANCELED"].includes(billing.state) ? (
          <p className="text-sm text-text-secondary">{BILLING_MESSAGES.recoveryForbidden}</p>
        ) : null}
      </Card>
    </AdminPage>
  );
}
