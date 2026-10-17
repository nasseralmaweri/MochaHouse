import type { Metadata } from "next";
import Link from "next/link";
import { PLATFORM_ONBOARDING_STUCK_DAYS_DEFAULT } from "@mocha-house/contracts";
import { PlatformCard, PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { RegistrationControlPanel } from "@/components/platform/RegistrationControlPanel";
import { NoPermissionPanel } from "@/components/platform/OnboardingFilters";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { getRegistrationControl } from "@/lib/platform/tenants-api";
import {
  ONBOARDING_MANAGE_PERMISSION,
  ONBOARDING_VIEW_PERMISSION,
} from "@/lib/platform/onboarding";

export const metadata: Metadata = {
  title: "Onboarding · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const LINK =
  "font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

// SC4e — onboarding oversight: whether new owner registrations are accepted
// (and the emergency pause), what needs attention, and the two reports.
// onboarding.view to see it; onboarding.manage to pause or resume. The API
// re-checks both on every request.
export default async function PlatformOnboardingPage() {
  const session = await getPlatformSession();
  const permissions = session.state === "signed-in" ? session.permissions : [];
  const header = (
    <PlatformPageHeader
      title="Onboarding"
      description="Business owners who sign up themselves: registrations, their businesses' setup progress, and the emergency pause for new registrations."
    />
  );
  if (!permissions.includes(ONBOARDING_VIEW_PERMISSION)) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <NoPermissionPanel permission={ONBOARDING_VIEW_PERMISSION} />
      </div>
    );
  }

  const result = await getRegistrationControl();
  return (
    <div className="flex flex-col gap-6">
      {header}
      {result.state !== "ok" ? (
        <RegistryStatePanel state={result.state} retryHref="/platform/onboarding" />
      ) : (
        <>
          <RegistrationControlPanel
            view={result.data}
            canManage={permissions.includes(ONBOARDING_MANAGE_PERMISSION)}
          />
          <PlatformCard title="Needs attention">
            <ul className="flex flex-col gap-2 text-sm">
              <li>
                <Link href="/platform/onboarding/registrations?filter=expired" className={LINK}>
                  {plural(result.data.issues.expired, "registration")} whose code expired before verification
                </Link>
              </li>
              <li>
                <Link href="/platform/onboarding/registrations?filter=stalled" className={LINK}>
                  {plural(result.data.issues.stalled, "registration")} stopped in verification
                </Link>{" "}
                <span className="text-text-secondary">(password not set, or every code attempt used)</span>
              </li>
              <li>
                <Link href="/platform/onboarding/registrations?filter=no-business" className={LINK}>
                  {plural(result.data.issues.verifiedWithoutBusiness, "verified owner")} without a business yet
                </Link>
              </li>
              <li>
                <Link
                  href={`/platform/onboarding/businesses?filter=stuck&stuckDays=${PLATFORM_ONBOARDING_STUCK_DAYS_DEFAULT}`}
                  className={LINK}
                >
                  Businesses not finished with setup after {PLATFORM_ONBOARDING_STUCK_DAYS_DEFAULT} days
                </Link>
              </li>
            </ul>
            <p className="text-xs text-text-muted">
              Monitoring only: operators can&apos;t act as an owner, delete a registration or skip email
              verification. Payment setup deadlines are extended on the business&apos;s page (billing permission).
            </p>
          </PlatformCard>
          <PlatformCard title="Reports">
            <ul className="flex flex-col gap-2 text-sm">
              <li>
                <Link href="/platform/onboarding/registrations" className={LINK}>
                  Registrations
                </Link>{" "}
                <span className="text-text-secondary">— every sign-up, its status and dates</span>
              </li>
              <li>
                <Link href="/platform/onboarding/businesses" className={LINK}>
                  Setup progress
                </Link>{" "}
                <span className="text-text-secondary">— each self-service business&apos;s getting-started steps</span>
              </li>
              <li>
                <Link href="/platform/billing/payment-setup" className={LINK}>
                  Awaiting payment setup
                </Link>{" "}
                <span className="text-text-secondary">— in Billing</span>
              </li>
            </ul>
          </PlatformCard>
        </>
      )}
    </div>
  );
}
