import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { can } from "@/lib/admin/capabilities";
import { getAdminBilling } from "@/lib/internal-auth/admin-billing";
import {
  BILLING_MESSAGES,
  BILLING_STATE_LABELS,
  billingStateDescription,
  checkoutReturn,
} from "@/lib/admin/billing";
import { formatMinorUnits } from "@/lib/admin/crm";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden, AdminNotFound } from "@/components/admin/states";
import { Card } from "@/components/Card";
import { SetUpPaymentForm } from "./SetUpPaymentForm";
import { CheckoutConfirming } from "./CheckoutConfirming";
import { ForgetCheckoutReturn } from "./ForgetCheckoutReturn";

// SC3b — the business's own CENTERIVO subscription: plan, price and billing
// status, and (owner) payment setup through the provider's hosted Checkout.
// Restaurant customer payments are unrelated and never shown here.
export default async function AdminBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
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

  const { billing, canSetUpPayment } = result.data;
  const returned = checkoutReturn(params.checkout);
  // Back from the provider but not confirmed yet: the page re-reads itself
  // and the setup button is hidden (nothing needs setting up again).
  const confirming = returned === "success" && billing.state === "AWAITING_SETUP";
  const date = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-US", { dateStyle: "long" }) : null;

  return (
    <AdminPage>
      {header}
      {returned && !confirming ? <ForgetCheckoutReturn /> : null}
      {confirming ? (
        <CheckoutConfirming />
      ) : returned === "success" ? (
        <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
          Payment setup is complete.
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
      </Card>
    </AdminPage>
  );
}
