"use client";

import { useEffect, useRef } from "react";

// SC3d-3 — the latest plan change's status line. When its status changes
// while the page is open (a scheduled change cancelled, a change confirmed)
// the line takes focus, so the outcome is read out and keyboard users are
// not left on a control that has gone.
export function PlanChangeStatus({ status, message }: { status: string; message: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const previous = useRef(status);

  useEffect(() => {
    if (previous.current !== status) ref.current?.focus();
    previous.current = status;
  }, [status]);

  return (
    <p
      ref={ref}
      tabIndex={-1}
      role="status"
      className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary focus:outline-none"
    >
      {message}
    </p>
  );
}
