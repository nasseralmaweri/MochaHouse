import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";

export function OrderNotFoundState({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-start gap-4 px-4 py-8">
      <PageHeader title={title} subtitle={message} />
      <BackLink href="/order/location">Choose a location</BackLink>
    </main>
  );
}
