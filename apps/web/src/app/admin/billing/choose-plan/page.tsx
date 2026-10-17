import Link from "next/link";
import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { can } from "@/lib/admin/capabilities";
import { SELECTION_UNAVAILABLE_MESSAGE } from "@/lib/admin/billing";
import {
  getAdminBilling,
  getAdminInitialPlanOptions,
} from "@/lib/internal-auth/admin-billing";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { Card } from "@/components/Card";
import { ChoosePlanForm } from "./ChoosePlanForm";

// SC4c — a business its owner created changes its plan and price before the
// first payment setup (owner decision C3). The API decides what is offered
// and refuses anything else; nothing is charged here.
export default async function ChoosePlanPage() {
  const session = await getInternalSession();
  if (!session) redirect("/internal/sign-in");
  const header = (
    <AdminPageHeader
      title="Choose your plan"
      description="Pick the plan and price you want before setting up payment. Nothing is charged here."
    />
  );
  if (!can(session.authorization.capabilities, "billing.manage")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }
  const billing = await getAdminBilling();
  if (billing.outcome === "unauthenticated") redirect("/internal/sign-in");
  const initialSetup = billing.outcome === "success" ? billing.data.initialSetup : null;
  const options = billing.outcome === "success" && initialSetup ? await getAdminInitialPlanOptions() : null;
  const back = (
    <Link
      href="/admin/billing"
      className="inline-flex min-h-11 items-center text-sm font-medium text-text-primary underline underline-offset-4"
    >
      Back to billing
    </Link>
  );

  if (billing.outcome === "success" && !initialSetup) {
    return (
      <AdminPage>
        {header}
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-text-primary">
            Your plan can be changed here only before payment is set up. To change your plan now, use
            Billing.
          </p>
        </Card>
        {back}
      </AdminPage>
    );
  }
  return (
    <AdminPage>
      {header}
      {options === null ? (
        <AdminErrorState description="We couldn't load the plans just now. Please try again." />
      ) : options.plans.length === 0 ? (
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-text-primary">
            No plans are available to choose right now. Please check back soon.
          </p>
        </Card>
      ) : (
        <Card className="flex flex-col gap-4">
          {initialSetup && !initialSetup.selectionAvailable ? (
            <p role="status" className="rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-text-primary">
              {SELECTION_UNAVAILABLE_MESSAGE}
            </p>
          ) : null}
          <ChoosePlanForm plans={options.plans} current={options.current} />
        </Card>
      )}
      {back}
    </AdminPage>
  );
}
