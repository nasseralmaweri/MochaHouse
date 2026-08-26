import { redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/PageHeader";
import { SignInForm } from "./SignInForm";

export default async function SignInPage() {
  const session = await getCustomerSession();
  if (session) {
    redirect("/account");
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader title="Sign in" subtitle="Access your Mocha House account." />
      <SignInForm />
    </main>
  );
}
