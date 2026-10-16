"use client";

import { useEffect } from "react";

// SC3b/SC3c-2 — once a return from the provider has been shown, drop
// "?checkout=…" / "?portal=…" from the address so a later reload or
// bookmark doesn't repeat the banner.
export function ForgetCheckoutReturn() {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("checkout") && !url.searchParams.has("portal")) return;
    url.searchParams.delete("checkout");
    url.searchParams.delete("portal");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);
  return null;
}
