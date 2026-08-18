"use client";

import Link from "next/link";
import { useCart } from "@/lib/cart/store";

export function CartLink() {
  const cart = useCart();

  return (
    <Link
      href="/order/cart"
      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border-default bg-surface-card px-4 py-2 text-sm font-medium text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      Cart
      {cart.isHydrated && cart.itemCount > 0 ? (
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-status-success/10 px-1 text-xs font-semibold text-status-success">
          {cart.itemCount}
        </span>
      ) : null}
    </Link>
  );
}
