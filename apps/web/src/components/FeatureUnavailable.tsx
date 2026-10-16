import Link from "next/link";
import { Card } from "@/components/Card";

// SC2b — shown where this business does not offer a feature (its plan does
// not include it). Plain and calm: nothing is wrong with the customer's
// request, and nothing they already have (orders, balances) is affected.
export function FeatureUnavailable({
  message,
  linkHref = "/",
  linkLabel = "Back to home",
}: {
  message: string;
  linkHref?: string;
  linkLabel?: string;
}) {
  return (
    <Card tone="subtle" className="flex flex-col gap-3 text-sm text-text-secondary">
      <p role="status">{message}</p>
      <Link
        href={linkHref}
        className="self-start text-sm font-medium text-text-primary underline underline-offset-2"
      >
        {linkLabel}
      </Link>
    </Card>
  );
}
