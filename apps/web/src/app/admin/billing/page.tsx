import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { can } from "@/lib/admin/capabilities";
import Link from "next/link";
import {
  getAdminBilling,
  getAdminPaymentMethod,
  getAdminPlanOptions,
} from "@/lib/internal-auth/admin-billing";
import { BILLING_HISTORY_MESSAGES, paymentMethodSentence } from "@/lib/admin/billing-history";
import { canCancelScheduled, planChangeStatusMessage } from "@/lib/admin/plan-change";
import { formatDeadline } from "@/lib/admin/billing";
import {
  BILLING_MESSAGES,
  PAYMENT_SETUP_EXPIRED_MESSAGE,
  BILLING_STATE_LABELS,
  SELECTION_UNAVAILABLE_MESSAGE,
  billingStateDescription,
  initialSetupDisclosure,
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
import { ChangePlanPanel } from "./ChangePlanPanel";
import { CancelScheduledChangeForm } from "./CancelScheduledChangeForm";
import { PlanChangeStatus } from "./PlanChangeStatus";

// SC3b — the business's own CENTERIVO subscription: plan, price and billing
// status, and (owner) payment setup through the provider's hosted Checkout.
// Restaurant customer payments are unrelated and never shown here.
export default async function AdminBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; portal?: string; plan?: string }>;
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
    canChangePlan,
    planChange,
    initialSetup,
  } = result.data;
  // SC3d-2 — the plans the business may move to (only when it may).
  const planOptions = canChangePlan ? await getAdminPlanOptions() : null;
  // SC3e-1 — what may be shown of the payment method (billed businesses).
  const billed = billing.state !== "COMPLIMENTARY" && billing.state !== "AWAITING_SETUP";
  const paymentMethod = billed ? await getAdminPaymentMethod() : null;
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
      {params.plan === "saved" && initialSetup ? (
        <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
          Your plan is saved. Nothing was charged. Set up payment below when you&apos;re ready.
        </p>
      ) : null}
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
              <dt className="text-text-secondary">
                {initialSetup && !initialSetup.selectionAvailable
                  ? "Your previous choice (no longer offered)"
                  : billing.state === "AWAITING_SETUP"
                    ? "Price after payment setup"
                    : "Price"}
              </dt>
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
          {billing.enforced && billing.paymentSetup.required && billing.paymentSetup.deadline ? (
            <div>
              <dt className="text-text-secondary">Set up payment by</dt>
              <dd className="font-medium text-text-primary">{formatDeadline(billing.paymentSetup.deadline)}</dd>
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
        {billing.paymentSetup.expired ? (
          <p role="status" className="rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-text-primary">
            {PAYMENT_SETUP_EXPIRED_MESSAGE}
          </p>
        ) : null}
        {/* SC4c — a self-service business's first payment setup. */}
        {initialSetup && !confirming ? (
          initialSetup.selectionAvailable ? (
            <p className="text-sm text-text-primary">
              {initialSetupDisclosure(initialSetup.trial, billing.price)}
            </p>
          ) : (
            <p role="status" className="rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-text-primary">
              {SELECTION_UNAVAILABLE_MESSAGE}
            </p>
          )
        ) : null}
        {canSetUpPayment && !confirming ? (
          <SetUpPaymentForm label={initialSetup ? "Set up payment now" : undefined} />
        ) : initialSetup && (initialSetup.canChangeSelection || !initialSetup.selectionAvailable) ? null : billing.state === "AWAITING_SETUP" && !confirming ? (
          <p className="text-sm text-text-secondary">{BILLING_MESSAGES.forbidden}</p>
        ) : null}
        {initialSetup?.canChangeSelection && !confirming ? (
          <Link
            href="/admin/billing/choose-plan"
            className="inline-flex min-h-11 items-center text-sm font-medium text-text-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            {initialSetup.selectionAvailable ? "Change plan or price" : "Choose a plan"}
          </Link>
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
      {billed ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-base font-semibold text-text-primary">Payment method and invoices</h2>
          {paymentMethod?.outcome === "success" ? (
            <>
              <p className="text-sm text-text-primary">
                {paymentMethodSentence(paymentMethod.data.paymentMethod ?? { kind: "NONE", card: null })}
              </p>
              {paymentMethod.data.paymentMethod?.card?.expired ? (
                <p className="text-sm text-status-error">
                  This card has expired. Update your payment method so your next renewal can be paid.
                </p>
              ) : null}
            </>
          ) : paymentMethod?.outcome === "unavailable" ? (
            <p className="text-sm text-text-secondary">{BILLING_HISTORY_MESSAGES.paymentMethodUnavailable}</p>
          ) : null}
          {canManagePaymentMethod && !confirming ? (
            <p className="text-xs text-text-secondary">
              To change it, use Update payment method above — card details are entered on our payment
              provider&apos;s secure page, never here.
            </p>
          ) : null}
          <Link
            href="/admin/billing/invoices"
            className="inline-flex min-h-11 items-center self-start text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            View billing history
          </Link>
        </Card>
      ) : null}
      {planChange || (canChangePlan && planOptions) ? (
        <Card className="flex flex-col gap-4">
          {planChange ? (
            <div className="flex flex-col gap-2">
              <PlanChangeStatus status={planChange.status} message={planChangeStatusMessage(planChange)} />
              {planChange.status === "PROCESSING" ? (
                <a
                  href="/admin/billing"
                  className="self-start text-sm font-medium text-text-primary underline underline-offset-2"
                >
                  Refresh status
                </a>
              ) : null}
              {planChange.status === "PAYMENT_NEEDED" && can(session.authorization.capabilities, "billing.manage") ? (
                <BillingActionForm kind="planChange" />
              ) : null}
              {planChange.status === "SCHEDULED" && can(session.authorization.capabilities, "billing.manage") ? (
                canCancelScheduled(planChange) ? (
                  <CancelScheduledChangeForm planChangeId={planChange.id} />
                ) : (
                  <p className="text-sm text-text-secondary">
                    It&apos;s too close to {formatDeadline(planChange.effectiveAt!)} to cancel. The change still
                    takes effect then.
                  </p>
                )
              ) : null}
            </div>
          ) : null}
          {canChangePlan && planOptions ? <ChangePlanPanel options={planOptions} /> : null}
        </Card>
      ) : null}
    </AdminPage>
  );
}
