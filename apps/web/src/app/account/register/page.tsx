import { redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";
import { RegisterForm } from "./RegisterForm";

export default async function RegisterPage() {
  const session = await getCustomerSession();
  if (session) {
    redirect("/account");
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Create account"
        subtitle="Join Mocha House to track your orders."
      />
      <RegisterForm />
      <BackLink href="/account/sign-in">Already have an account? Sign in</BackLink>
    </main>
  );
}
