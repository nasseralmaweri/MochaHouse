import { redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";
import { Card } from "@/components/Card";
import { SignInForm } from "./SignInForm";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ verified?: string }>;
}) {
  const session = await getCustomerSession();
  if (session) {
    redirect("/account");
  }

  const { verified } = await searchParams;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader title="Sign in" subtitle="Access your Mocha House account." />

      {verified ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          {verified} is verified — you can sign in now.
        </Card>
      ) : null}

      <SignInForm />
      <BackLink href="/account/register">
        New to Mocha House? Create an account
      </BackLink>
    </main>
  );
}
