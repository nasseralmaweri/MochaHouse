import { redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";
import { Card } from "@/components/Card";
import { SignInForm } from "./SignInForm";
import { named, requireStorefrontProfile } from "@/lib/storefront-profile";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ verified?: string; reset?: string }>;
}) {
  const profile = await requireStorefrontProfile();
  const session = await getCustomerSession();
  if (session) {
    redirect("/account");
  }

  const { verified, reset } = await searchParams;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Sign in"
        subtitle={named(profile, "Access your {name} account.", "Access your account.")}
      />

      {verified ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          {verified} is verified — you can sign in now.
        </Card>
      ) : null}

      {reset ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          Your password has been reset — sign in with your new password.
        </Card>
      ) : null}

      <SignInForm />

      <div className="flex flex-col gap-2">
        <BackLink href="/account/forgot-password">Forgot password?</BackLink>
        <BackLink href="/account/register">
          {named(profile, "New to {name}? Create an account", "New here? Create an account")}
        </BackLink>
      </div>
    </main>
  );
}
