"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const INTERVAL_MS = 3000;
const LIMIT_MS = 60_000;

// SC3b — after returning from the provider's Checkout, the payment setup is
// confirmed by the provider's notification, which can take a few seconds.
// This re-reads the page for up to a minute (the server decides the state),
// then says plainly to refresh later. It never claims more than it does.
export function CheckoutConfirming() {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started >= LIMIT_MS) {
        window.clearInterval(timer);
        setGaveUp(true);
        // SC3c-2 — not confirmed within the minute: show the page as
        // "pending" (its actions available again), never a dead end.
        router.replace("/admin/billing?checkout=pending");
        return;
      }
      router.refresh();
    }, INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [router]);

  return (
    <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
      {gaveUp
        ? "We're still confirming your payment setup with our payment provider. Refresh this page in a minute — you don't need to set it up again."
        : "We're confirming your payment setup with our payment provider…"}
    </p>
  );
}
