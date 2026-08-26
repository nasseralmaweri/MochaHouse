import { redirect } from "next/navigation";
import type { CustomerAccountStatus } from "@mocha-house/contracts";
import { getCustomerSession } from "@/lib/auth/session";
import { signOutAction } from "@/lib/auth/actions";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";

const STATUS_LABEL: Record<CustomerAccountStatus, string> = {
  ACTIVE: "Active",
  RESTRICTED: "Restricted",
  DEACTIVATED: "Deactivated",
};

// Minimal Account Home: proves the authenticated customer identity is being
// resolved from the API (GET /customers/me) — nothing here reads order
// history, loyalty, or any other capability out of scope for this slice.
export default async function AccountPage() {
  const session = await getCustomerSession();
  if (!session) {
    redirect("/account/sign-in");
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Account"
        subtitle={session.displayName ?? session.email ?? undefined}
      />

      <Card className="flex flex-col gap-2 text-sm text-text-secondary">
        <div className="flex items-center justify-between gap-4">
          <span>Email</span>
          <span className="text-text-primary">{session.email ?? "—"}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span>Status</span>
          <span className="text-text-primary">{STATUS_LABEL[session.status]}</span>
        </div>
      </Card>

      <form action={signOutAction}>
        <button
          type="submit"
          className="flex min-h-11 w-full items-center justify-center rounded-xl border border-border-default px-4 py-3 text-base font-semibold text-text-primary"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
