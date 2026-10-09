import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { CenterivoWordmark } from "@/components/centerivo/Wordmark";
import { centerivoSans } from "@/components/centerivo/fonts";
import { InternalSignInForm } from "./InternalSignInForm";

export const metadata: Metadata = { title: "Sign in · CENTERIVO" };

// The platform front door. Deliberately tenant-neutral: the person signing
// in may belong to one business or several, so nothing here names a business.
// There is no "create an account" link: internal users are provisioned
// administratively.
export default async function InternalSignInPage() {
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
            Welcome back
          </h1>
          <p className="text-[0.9375rem] text-text-secondary">
            Sign in to your CENTERIVO account.
          </p>
        </div>
        <div
          className="rounded-2xl border border-border-default bg-surface-card p-6 sm:p-7"
          style={{ boxShadow: "var(--cx-shadow-raised)" }}
        >
          <InternalSignInForm />
        </div>
      </main>
    </div>
  );
}
