import { redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";
import { Card } from "@/components/Card";
import { ResetPasswordForm } from "./ResetPasswordForm";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const session = await getCustomerSession();
  if (session) {
    redirect("/account");
  }

  const { email } = await searchParams;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Enter your new password"
        subtitle="Use the recovery code from your email to set a new password."
      />

      <Card tone="subtle" className="text-sm text-text-secondary">
        If an account exists for that email, a recovery code has been sent.
        Enter it below with your new password.
      </Card>

      <ResetPasswordForm initialEmail={email ?? ""} />
      <BackLink href="/account/forgot-password">
        Didn&apos;t get a code? Request another
      </BackLink>
    </main>
  );
}
