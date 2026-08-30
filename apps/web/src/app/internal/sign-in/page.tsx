import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { PageHeader } from "@/components/PageHeader";
import { InternalSignInForm } from "./InternalSignInForm";

// The minimal internal sign-in screen (Milestone 5A). An authentication
// proof screen, not an Admin design — no navigation, no branding shell.
// There is deliberately no "create an account" link: internal users are
// provisioned administratively.
export default async function InternalSignInPage() {
  const session = await getInternalSession();
  if (session) {
    redirect("/admin/orders");
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Internal sign in"
        subtitle="Mocha House staff access."
      />
      <InternalSignInForm />
    </main>
  );
}
