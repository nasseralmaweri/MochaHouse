"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  LOYALTY_POINTS_LABEL_MAX,
  type LoyaltyPointsLabelSettings,
} from "@mocha-house/contracts";
import { updateLoyaltyPointsLabelFromBrowser } from "@/lib/api-client";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";

// SC4f-3b (owner decision J5) — the business's own name for its loyalty
// points, shown to customers and staff. Presentation only: balances,
// earning and redemption never change. Blank restores the default.
export function PointsLabelForm({ settings }: { settings: LoyaltyPointsLabelSettings }) {
  const router = useRouter();
  const [label, setLabel] = useState(settings.pointsLabel ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setNotice(null);
    setPending(true);
    const trimmed = label.trim();
    const result = await updateLoyaltyPointsLabelFromBrowser({
      pointsLabel: trimmed === "" ? null : trimmed,
    });
    setPending(false);
    if (result.outcome === "success") {
      setLabel(result.data.pointsLabel ?? "");
      setNotice(`Customers and staff now see "${result.data.effectivePointsLabel}".`);
      router.refresh();
      return;
    }
    if (result.outcome === "forbidden") {
      setError("You don't have permission to change loyalty settings.");
    } else if (result.outcome === "not-found") {
      setError("The loyalty configuration could not be found.");
    } else {
      setError(result.message);
    }
  }

  return (
    <form
      className="flex max-w-md flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <FormField
        label="Name for loyalty points"
        htmlFor="points-label"
        hint={`Shown to customers and staff, e.g. "Stars". Leave blank to use the default name. Display only — balances and rewards don't change.`}
      >
        <input
          id="points-label"
          value={label}
          maxLength={LOYALTY_POINTS_LABEL_MAX}
          onChange={(event) => {
            setLabel(event.target.value);
            setError(null);
          }}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-status-success">
          {notice}
        </p>
      ) : null}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save name"}
        </Button>
      </div>
    </form>
  );
}
