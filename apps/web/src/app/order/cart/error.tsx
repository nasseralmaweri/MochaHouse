"use client";

import { OrderErrorState } from "@/components/OrderErrorState";

export default function OrderCartError({
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
      message="We couldn't load your cart. Please try again."
    />
  );
}
