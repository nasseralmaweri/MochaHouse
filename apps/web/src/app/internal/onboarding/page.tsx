import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CenterivoWordmark } from "@/components/centerivo/Wordmark";
import { centerivoSans } from "@/components/centerivo/fonts";
import { fetchOnboardingStatus, getOnboardingToken } from "@/lib/internal-auth/onboarding";
import { onboardingSignOutAction } from "@/lib/internal-auth/onboarding-actions";
import { CreateBusinessForm, EnterBusinessForm } from "./CreateBusinessForm";

export const metadata: Metadata = { title: "Set up your business · CENTERIVO" };

const LINK =
  "mt-3 inline-block text-sm font-medium text-text-primary underline underline-offset-4";

// SC4b — a verified, self-registered owner creates their business. Reached
// only with the restricted onboarding session (set at sign-in for an owner
// without a business); the API decides eligibility, plans and prices.
export default async function OnboardingPage() {
  const token = await getOnboardingToken();
  if (!token) {
    redirect("/internal/sign-in");
  }
  const result = await fetchOnboardingStatus(token);

  let body: React.ReactNode;
  if (result.outcome === "ok" && result.status.status === "BUSINESS_REQUIRED") {
    body = (
      <>
        <div className="flex flex-col gap-2">
          <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-text-primary">
            Set up your business
          </h1>
          <p className="text-[0.9375rem] text-text-secondary">
            Welcome, {result.status.ownerName}. Name your business and choose a plan.
          </p>
        </div>
        {result.status.plans.length === 0 ? (
          <Panel>
            <p className="text-sm text-text-primary">
              No plans are available to choose right now. Please check back soon.
            </p>
            <Link href="/internal/onboarding" className={LINK}>
              Check again
            </Link>
          </Panel>
        ) : (
          <Panel>
            <CreateBusinessForm plans={result.status.plans} />
          </Panel>
        )}
      </>
    );
  } else if (result.outcome === "ok") {
    body = (
      <>
        <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-text-primary">
          {result.status.status === "BUSINESS_CREATED" ? result.status.business.name : ""} is ready
        </h1>
        <Panel>
          <EnterBusinessForm />
        </Panel>
      </>
    );
  } else {
    body = (
      <Panel>
        <p className="text-sm text-text-primary">
          {result.outcome === "error"
            ? "Could not reach the server. Please try again in a moment."
            : result.outcome === "unauthenticated"
              ? "Your session has ended. Sign in again to continue."
              : "This account can't set up a business here. Contact CENTERIVO support if you think this is wrong."}
        </p>
        {result.outcome === "error" ? (
          <Link href="/internal/onboarding" className={LINK}>
            Try again
          </Link>
        ) : (
          <form action={onboardingSignOutAction}>
            <button type="submit" className={LINK}>
              Sign in again
            </button>
          </form>
        )}
      </Panel>
    );
  }

  return (
    <div
      className={`${centerivoSans.variable} centerivo flex min-h-dvh flex-col items-center px-4 py-12 sm:py-20`}
    >
      <CenterivoWordmark />
      <main className="mt-16 flex w-full max-w-xl flex-1 flex-col gap-8 sm:mt-24 sm:flex-none">
        {body}
        <form action={onboardingSignOutAction}>
          <button
            type="submit"
            className="text-sm font-medium text-text-secondary underline underline-offset-4 hover:text-text-primary"
          >
            Sign out
          </button>
        </form>
      </main>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-2xl border border-border-default bg-surface-card p-6 sm:p-7"
      style={{ boxShadow: "var(--cx-shadow-raised)" }}
    >
      {children}
    </div>
  );
}
