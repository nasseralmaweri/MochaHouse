"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { updateLocationDigitalOrderingFromBrowser } from "@/lib/api-client";
import { Button } from "./Button";
import { StatusBadge } from "./StatusBadge";

// The operational "Online Ordering" control on a location's detail page
// (Milestone 5D-2). Shown only when the viewer may manage online ordering
// for this location — the API still enforces that independently.
//
// Turning it OFF has immediate customer impact, so it asks for a quick
// confirmation first (inline, no modal). Turning it ON is immediate. State
// is refreshed from the server after every change (router.refresh) so the
// rest of the page stays in sync.
export function LocationOrderingControl({
  locationId,
  initialEnabled,
}: {
  locationId: string;
  initialEnabled: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, setPending] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  // Re-sync if the server sends a new value (e.g. after router.refresh, or
  // if someone else changed it and the page was reloaded).
  useEffect(() => {
    setEnabled(initialEnabled);
  }, [initialEnabled]);

  async function apply(next: boolean) {
    setPending(true);
    setFeedback(null);
    const result = await updateLocationDigitalOrderingFromBrowser(
      locationId,
      next,
    );
    setPending(false);
    setConfirmingOff(false);

    if (result.outcome === "success") {
      setEnabled(result.isDigitalOrderingEnabled);
      setFeedback({
        tone: "success",
        text: result.isDigitalOrderingEnabled
          ? "Online ordering is on."
          : "Online ordering is off.",
      });
      router.refresh();
      return;
    }
    if (result.outcome === "forbidden") {
      setFeedback({
        tone: "error",
        text: "You don't have permission to change this.",
      });
      return;
    }
    if (result.outcome === "not-found") {
      setFeedback({ tone: "error", text: "This location no longer exists." });
      return;
    }
    setFeedback({ tone: "error", text: result.message });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          label={enabled ? "On" : "Off"}
          tone={enabled ? "positive" : "warning"}
        />
        <span className="text-sm text-text-secondary">
          {enabled
            ? "This location is accepting online orders."
            : "This location isn't accepting online orders right now."}
        </span>
      </div>

      {confirmingOff ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border-default bg-surface-subtle px-3 py-3">
          <p className="text-sm text-text-primary">
            Turn off online ordering for this location? Customers won&apos;t be
            able to place online orders until you turn it back on.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void apply(false)} disabled={pending}>
              {pending ? "Turning off…" : "Turn off"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfirmingOff(false)}
              disabled={pending}
            >
              Keep it on
            </Button>
          </div>
        </div>
      ) : enabled ? (
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              setFeedback(null);
              setConfirmingOff(true);
            }}
            disabled={pending}
          >
            Turn off
          </Button>
        </div>
      ) : (
        <div>
          <Button onClick={() => void apply(true)} disabled={pending}>
            {pending ? "Turning on…" : "Turn on"}
          </Button>
        </div>
      )}

      {feedback ? (
        <p
          role="status"
          className={`text-sm ${
            feedback.tone === "success"
              ? "text-status-success"
              : "text-status-warning"
          }`}
        >
          {feedback.text}
        </p>
      ) : null}
    </div>
  );
}
