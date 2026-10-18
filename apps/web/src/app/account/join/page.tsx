import Link from "next/link";
import { redirect } from "next/navigation";
import { getCustomerAccountState } from "@/lib/auth/session";
import { safeReturnPath } from "@/lib/auth/enrollment";
import { signOutAction } from "@/lib/auth/actions";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { JoinForm } from "./JoinForm";

// SC4f-2 — a signed-in CENTERIVO login that has not joined THIS restaurant
// yet. The restaurant's name comes from the API's resolved storefront, never
// from the address bar. Joining is an explicit choice; the customer can also
// order as a guest (where guest ordering is offered) or sign out.
export default async function JoinRestaurantPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next: rawNext } = await searchParams;
  const next = safeReturnPath(Array.isArray(rawNext) ? rawNext[0] : rawNext);

  const state = await getCustomerAccountState();
  if (state.kind === "signed-out") {
    redirect("/account/sign-in");
  }
  if (state.kind === "signed-in") {
    redirect(next);
  }
  const { businessName } = state;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title={`Join ${businessName}`}
        subtitle={`Join ${businessName} with your CENTERIVO account.`}
      />

      <Card className="flex flex-col gap-2 text-sm text-text-secondary">
        <p>
          You&apos;re signed in, but you haven&apos;t joined {businessName}{" "}
          yet. Joining creates your account here, using your CENTERIVO
          sign-in.
        </p>
        <p>
          {businessName} keeps its own orders, rewards, gift cards and
          preferences for you. Nothing from other restaurants is shared, and
          marketing emails stay off unless you turn them on.
        </p>
      </Card>

      <JoinForm businessName={businessName} next={next} />

      <div className="flex flex-col gap-3 text-sm">
        <Link
          href="/order/location"
          className="flex min-h-11 items-center justify-center rounded-xl border border-border-default px-4 py-3 font-semibold text-text-primary"
        >
          Order as a guest instead
        </Link>
        <form action={signOutAction}>
          <button
            type="submit"
            className="w-full text-center text-text-secondary underline underline-offset-4"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
