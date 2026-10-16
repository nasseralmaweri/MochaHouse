"use client";

import { useEffect, useRef } from "react";

// SC1c — the tenant list's result summary ("Showing 1–20 of 45 …"). After a
// search, filter or page change (a client-side navigation that remounts the
// list), focus moves here so the new results are announced and keyboard
// users continue from the results. On the first visit focus is left alone.
let previousKey: string | null = null;

export function RegistryResultsStatus({
  resultKey,
  message,
}: {
  resultKey: string;
  message: string;
}) {
  const element = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (previousKey !== null && previousKey !== resultKey) {
      element.current?.focus();
    }
    previousKey = resultKey;
  }, [resultKey]);

  return (
    <p
      ref={element}
      role="status"
      tabIndex={-1}
      className="rounded text-sm text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
    >
      {message}
    </p>
  );
}
