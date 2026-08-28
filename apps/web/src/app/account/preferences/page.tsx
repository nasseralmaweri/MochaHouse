import { redirect } from "next/navigation";
import { getCustomerSessionToken } from "@/lib/auth/session";
import { getCommunicationPreferences } from "@/lib/auth/preferences";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";
import { PreferencesForm } from "./PreferencesForm";

export const dynamic = "force-dynamic";

export default async function PreferencesPage() {
  const token = await getCustomerSessionToken();
  if (!token) {
    redirect("/account/sign-in");
  }

  const result = await getCommunicationPreferences(token);
  if (result.outcome === "unauthorized") {
    redirect("/account/sign-in");
  }

  if (result.outcome === "error") {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title="Preferences" />
        <Card tone="subtle" className="text-sm text-status-warning">
          We couldn&apos;t load your preferences. Please try again later.
        </Card>
        <BackLink href="/account">Back to account</BackLink>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Preferences"
        subtitle="Choose which marketing emails you receive from Mocha House."
      />
      <PreferencesForm
        initialMarketingEmailOptIn={result.preferences.marketingEmailOptIn}
      />
      <BackLink href="/account">Back to account</BackLink>
    </main>
  );
}
