"use client";

import Link from "next/link";
import { Card } from "@/components/Card";

// Consistent Admin loading / empty / forbidden / error states. Each failure
// mode is visually and semantically distinct — 403 must never look like a
// sign-in problem, 404 must read as resource-not-found, 5xx/network must
// offer recovery.

export function AdminLoading({
  label = "Loading…",
}: {
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-3"
    >
      <span className="sr-only">{label}</span>
      <div className="h-4 w-40 animate-pulse rounded bg-surface-subtle" />
      <Card className="flex flex-col gap-3">
        <div className="h-4 w-2/3 animate-pulse rounded bg-surface-subtle" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-surface-subtle" />
      </Card>
    </div>
  );
}

export function AdminEmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <Card
      tone="subtle"
      className="flex flex-col items-start gap-2 text-sm text-text-secondary"
    >
      <p className="text-base font-medium text-text-primary">{title}</p>
      {description ? <p>{description}</p> : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </Card>
  );
}

// 403 — an authorization/scope limit, NOT an authentication failure.
export function AdminForbidden({
  title = "You don't have access to this",
  description = "Your role doesn't grant access here, or this location isn't in your assigned scope. Ask an administrator if you think this is wrong.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <Card className="flex flex-col items-start gap-2">
      <p className="text-base font-semibold text-text-primary">{title}</p>
      <p className="max-w-prose text-sm text-text-secondary">{description}</p>
      <Link
        href="/admin"
        className="pt-1 text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        Back to dashboard
      </Link>
    </Card>
  );
}

// 404 — resource not found (kept distinct from 403 and from generic errors).
export function AdminNotFound({
  title = "Not found",
  description = "This item doesn't exist, or it has moved.",
  backHref = "/admin",
  backLabel = "Back to dashboard",
}: {
  title?: string;
  description?: string;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <Card className="flex flex-col items-start gap-2">
      <p className="text-base font-semibold text-text-primary">{title}</p>
      <p className="text-sm text-text-secondary">{description}</p>
      <Link
        href={backHref}
        className="pt-1 text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {backLabel}
      </Link>
    </Card>
  );
}

// 5xx / network — recoverable. Always offers a retry.
export function AdminErrorState({
  title = "Something went wrong",
  description = "We couldn't complete that just now. Please try again.",
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <Card className="flex flex-col items-start gap-2">
      <p className="text-base font-semibold text-text-primary">{title}</p>
      <p className="text-sm text-text-secondary">{description}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="pt-1 text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Try again
        </button>
      ) : null}
    </Card>
  );
}
