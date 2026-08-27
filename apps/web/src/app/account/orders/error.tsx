"use client";

import { OrderErrorState } from "@/components/OrderErrorState";

export default function AccountOrdersError({
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
      message="We couldn't load your orders. Please try again."
      backHref="/account"
      backLabel="Back to account"
    />
  );
}
