"use client";

import { OrderErrorState } from "@/components/OrderErrorState";

export default function OrderProductError({
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
      message="We couldn't load this item. Please try again."
    />
  );
}
