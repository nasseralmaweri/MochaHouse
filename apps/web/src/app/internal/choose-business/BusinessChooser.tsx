"use client";

import { useState, useTransition } from "react";
import type { InternalBusinessSummary } from "@mocha-house/contracts";
import { switchBusinessAction } from "@/lib/internal-auth/admin-business";
import {
  IconChevronDown,
  IconSpinner,
} from "@/components/centerivo/Icons";

export function BusinessChooser({
  businesses,
}: {
  businesses: InternalBusinessSummary[];
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function choose(id: string) {
    setError(null);
    setPendingId(id);
    startTransition(async () => {
      const result = await switchBusinessAction(id);
      if (result?.error) {
        setError(result.error);
        setPendingId(null);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {businesses.map((business) => (
          <li key={business.id}>
            <button
              type="button"
              disabled={pending}
              onClick={() => choose(business.id)}
              className="group flex w-full items-center gap-4 rounded-xl border border-border-default bg-surface-card px-4 py-3.5 text-left transition-colors hover:border-accent/40 hover:bg-accent-soft/40 disabled:opacity-70"
            >
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-base font-semibold text-accent"
              >
                {business.name.trim().charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-base font-medium text-text-primary">
                {business.name}
              </span>
              {pendingId === business.id ? (
                <IconSpinner className="h-4 w-4 text-accent" />
              ) : (
                <IconChevronDown className="h-4 w-4 -rotate-90 text-text-muted group-hover:text-accent" />
              )}
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
