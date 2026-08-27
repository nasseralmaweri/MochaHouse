"use client";

import { OrderErrorState } from "@/components/OrderErrorState";

export default function AccountOrderDetailError({
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
      message="We couldn't load this order. Please try again."
      backHref="/account/orders"
      backLabel="Back to my orders"
    />
  );
}
