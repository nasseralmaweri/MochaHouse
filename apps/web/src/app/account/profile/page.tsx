import { redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";
import { Card } from "@/components/Card";
import { ProfileForm } from "./ProfileForm";

export default async function ProfilePage() {
  const session = await getCustomerSession();
  if (!session) {
    redirect("/account/sign-in");
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Profile"
        subtitle="Update the name shown on your Mocha House account."
      />

      <Card className="flex flex-col gap-2 text-sm text-text-secondary">
        <div className="flex items-center justify-between gap-4">
          <span>Email</span>
          <span className="text-text-primary">{session.email ?? "—"}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span>Email status</span>
          <span className="text-text-primary">
            {session.emailVerified ? "Verified" : "Not verified"}
          </span>
        </div>
      </Card>

      <ProfileForm initialDisplayName={session.displayName ?? ""} />

      <BackLink href="/account">Back to account</BackLink>
    </main>
  );
}
