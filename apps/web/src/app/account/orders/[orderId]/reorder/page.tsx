import { notFound, redirect } from "next/navigation";
import { getCustomerSessionToken } from "@/lib/auth/session";
import { prepareReorder } from "@/lib/auth/reorder";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";
import { Card } from "@/components/Card";
import { ReorderReview } from "./ReorderReview";

// Reorder always revalidates against the live menu, so render per request.
export const dynamic = "force-dynamic";

export default async function ReorderPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;

  const token = await getCustomerSessionToken();
  if (!token) {
    redirect("/account/sign-in");
  }

  const result = await prepareReorder(token, orderId);

  if (result.outcome === "unauthorized") {
    redirect("/account/sign-in");
  }
  // Same as order detail: a non-owned order is indistinguishable from a
  // missing one.
  if (result.outcome === "not-found") {
    notFound();
  }
  if (result.outcome === "error") {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title="Reorder" />
        <Card tone="subtle" className="text-sm text-status-warning">
          We couldn&apos;t prepare this reorder. Please try again later.
        </Card>
        <BackLink href={`/account/orders/${orderId}`}>Back to order</BackLink>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Reorder"
        subtitle={result.preparation.location.name}
      />
      <ReorderReview preparation={result.preparation} />
      <BackLink href={`/account/orders/${orderId}`}>Back to order</BackLink>
    </main>
  );
}
