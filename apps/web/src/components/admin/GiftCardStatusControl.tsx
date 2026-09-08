"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { GiftCardStatus } from "@mocha-house/contracts";
import { setGiftCardStatusFromBrowser } from "@/lib/api-client";
import { Button } from "./Button";

// Deactivate / reactivate a gift card (Milestone 7F). Rendered only for
// `giftcards.manage`. A status change never touches the balance or the
// ledger; the API audits it. An authorized correction is still permitted on
// an inactive card.
export function GiftCardStatusControl({
  giftCardId,
  status,
}: {
  giftCardId: string;
  status: GiftCardStatus;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const action = status === "ACTIVE" ? "deactivate" : "reactivate";

  async function submit() {
    setError(null);
    setPending(true);
    const result = await setGiftCardStatusFromBrowser(giftCardId, action);
    setPending(false);

    if (result.outcome === "success") {
      router.refresh();
      return;
    }
    if (result.outcome === "forbidden") {
      setError("You don't have permission to change a gift card's status.");
    } else if (result.outcome === "not-found") {
      setError("This gift card no longer exists.");
    } else {
      setError(result.message);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          onClick={() => void submit()}
          disabled={pending}
        >
          {pending
            ? "Working…"
            : status === "ACTIVE"
              ? "Deactivate gift card"
              : "Reactivate gift card"}
        </Button>
        <span className="text-xs text-text-muted">
          {status === "ACTIVE"
            ? "Deactivating stops future redemption. The balance is unchanged."
            : "This gift card is currently inactive."}
        </span>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}
    </div>
  );
}
