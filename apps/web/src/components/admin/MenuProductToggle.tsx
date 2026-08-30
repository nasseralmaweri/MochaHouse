"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { setMenuProductShownFromBrowser } from "@/lib/api-client";
import { Button } from "./Button";
import { StatusBadge } from "./StatusBadge";

// "Shown on menu" On/Off for one product placement (Milestone 5D-4). Uses
// the existing menu-assignment route. Hiding a product has customer impact,
// so it asks for a quick inline confirmation first; showing it is
// immediate. State is refreshed from the server after every change.
export function MenuProductToggle({
  menuId,
  productId,
  initialShown,
}: {
  menuId: string;
  productId: string;
  initialShown: boolean;
}) {
  const router = useRouter();
  const [shown, setShown] = useState(initialShown);
  const [pending, setPending] = useState(false);
  const [confirmingHide, setConfirmingHide] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setShown(initialShown);
  }, [initialShown]);

  async function apply(next: boolean) {
    setPending(true);
    setError(null);
    const result = await setMenuProductShownFromBrowser(menuId, productId, next);
    setPending(false);
    setConfirmingHide(false);

    if (result.outcome === "success") {
      setShown(next);
      router.refresh();
      return;
    }
    if (result.outcome === "forbidden") {
      setError("You don't have permission to change this.");
      return;
    }
    if (result.outcome === "not-found") {
      setError("This product is no longer on this menu.");
      return;
    }
    setError("message" in result ? result.message : "Something went wrong.");
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-text-secondary">Shown on menu</span>
        <StatusBadge
          label={shown ? "Yes" : "No"}
          tone={shown ? "positive" : "neutral"}
        />
      </div>

      {confirmingHide ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border-default bg-surface-subtle px-3 py-3">
          <p className="text-sm text-text-primary">
            Hide this product from this menu? Customers using this menu won&apos;t
            see it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void apply(false)} disabled={pending}>
              {pending ? "Hiding…" : "Hide it"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfirmingHide(false)}
              disabled={pending}
            >
              Keep it shown
            </Button>
          </div>
        </div>
      ) : shown ? (
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              setError(null);
              setConfirmingHide(true);
            }}
            disabled={pending}
          >
            Hide from menu
          </Button>
        </div>
      ) : (
        <div>
          <Button onClick={() => void apply(true)} disabled={pending}>
            {pending ? "Showing…" : "Show on menu"}
          </Button>
        </div>
      )}

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}
    </div>
  );
}
