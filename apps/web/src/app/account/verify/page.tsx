import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";
import { VerifyForm } from "./VerifyForm";

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const { email } = await searchParams;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Verify your email"
        subtitle="Enter the verification code we sent to your email address."
      />
      <VerifyForm initialEmail={email ?? ""} />
      <BackLink href="/account/sign-in">Back to sign in</BackLink>
    </main>
  );
}
