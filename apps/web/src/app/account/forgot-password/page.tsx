import { redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export default async function ForgotPasswordPage({
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
        title="Reset your password"
        subtitle="Enter your account email and we'll send you a recovery code."
      />
      <ForgotPasswordForm initialEmail={email ?? ""} />
      <BackLink href="/account/sign-in">Back to sign in</BackLink>
    </main>
  );
}
