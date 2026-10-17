import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getOwnerRegistrationAvailability } from "@/lib/internal-auth/registration";
import { CenterivoWordmark } from "@/components/centerivo/Wordmark";
import { centerivoSans } from "@/components/centerivo/fonts";
import { OwnerRegistrationForm } from "./OwnerRegistrationForm";

export const metadata: Metadata = { title: "Create an owner account · CENTERIVO" };

// SC4a — business owner self-service registration. Exists only while the API
// offers it (SELF_SERVICE_REGISTRATION_ENABLED, enforced by the API on every
// request); otherwise a 404 like any unknown page.
export default async function OwnerRegistrationPage() {
  const availability = await getOwnerRegistrationAvailability();
  if (!availability.enabled) {
    notFound();
  }
  const session = await getInternalSession();
  if (session) {
    redirect("/admin/orders");
  }

  return (
    <div
      className={`${centerivoSans.variable} centerivo flex min-h-dvh flex-col items-center px-4 py-12 sm:py-20`}
    >
      <CenterivoWordmark />
      <main className="mt-16 flex w-full max-w-sm flex-1 flex-col gap-8 sm:mt-24 sm:flex-none">
        <div className="flex flex-col gap-2">
          <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-text-primary">
            Create your owner account
          </h1>
          <p className="text-[0.9375rem] text-text-secondary">
            Start with your email. You&apos;ll set up your business next.
          </p>
        </div>
        <div
          className="rounded-2xl border border-border-default bg-surface-card p-6 sm:p-7"
          style={{ boxShadow: "var(--cx-shadow-raised)" }}
        >
          <OwnerRegistrationForm
            termsVersion={availability.termsVersion}
            privacyVersion={availability.privacyVersion}
            termsUrl={availability.termsUrl}
            privacyUrl={availability.privacyUrl}
          />
        </div>
      </main>
    </div>
  );
}
