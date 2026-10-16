"use client";

import { useState } from "react";

// SC1b — copies the authenticator setup key that the server already
// rendered on the page (it reads the text of the element it points at; the
// key is not passed in as a prop or held in component state).
export function CopySetupKey({ targetId }: { targetId: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    const text = document
      .getElementById(targetId)
      ?.textContent?.replace(/\s+/g, "");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <span className="mt-2 inline-flex items-center gap-3">
      <button
        type="button"
        onClick={() => void copy()}
        className="rounded-lg border border-border-default px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
      >
        Copy key
      </button>
      <span role="status" aria-live="polite" className="text-sm text-text-secondary">
        {status === "copied"
          ? "Copied."
          : status === "failed"
            ? "Could not copy — type the key instead."
            : ""}
      </span>
    </span>
  );
}
