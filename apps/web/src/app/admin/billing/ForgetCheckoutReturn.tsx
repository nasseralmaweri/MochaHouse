"use client";

import { useEffect } from "react";

// SC3b — once the Checkout return has been shown, drop "?checkout=…" from the
// address so a later reload or bookmark doesn't repeat the banner.
export function ForgetCheckoutReturn() {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("checkout")) return;
    url.searchParams.delete("checkout");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);
  return null;
}
