"use client";

import { OrderErrorState } from "@/components/OrderErrorState";

// SC4f-3b — a storefront page that could not be built (for example the
// storefront's business could not be confirmed during an outage). Names no
// business and guesses no presentation.
export default function StorefrontError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <OrderErrorState
      error={error}
      retry={retry}
      message="This page is temporarily unavailable. Please try again in a moment."
      backHref="/"
      backLabel="Home"
    />
  );
}
