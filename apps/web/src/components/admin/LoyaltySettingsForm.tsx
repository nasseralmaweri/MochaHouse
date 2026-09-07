"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { LoyaltySettings } from "@mocha-house/contracts";
import { updateLoyaltySettingsFromBrowser } from "@/lib/api-client";
import { parseEarningRate } from "@/lib/admin/loyalty-rewards";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";

// HQ earning-rate control (Milestone 7B). The API (`loyalty.configure`,
// CORPORATE-only) is the authority — it validates the range and audits the
// change. Changing the rate affects only FUTURE earning.
export function LoyaltySettingsForm({
  settings,
}: {
  settings: LoyaltySettings;
}) {
  const router = useRouter();
  const [rate, setRate] = useState(String(settings.earningRatePerDollar));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setNotice(null);
    const parsed = parseEarningRate(rate);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }

    setPending(true);
    const result = await updateLoyaltySettingsFromBrowser({
      earningRatePerDollar: parsed.value,
    });
    setPending(false);

    if (result.outcome === "success") {
      setRate(String(result.data.earningRatePerDollar));
      setNotice(
        `Customers now earn ${result.data.earningRatePerDollar} Mocha Bean${
          result.data.earningRatePerDollar === 1 ? "" : "s"
        } per qualifying dollar. This affects future orders only.`,
      );
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
    <div className="flex max-w-md flex-col gap-3">
      <FormField
        label="Mocha Beans per qualifying dollar"
        htmlFor="earning-rate"
        hint="A whole number between 1 and 100. Qualifying spend is whole dollars only."
      >
        <input
          id="earning-rate"
          inputMode="numeric"
          value={rate}
          onChange={(event) => {
            setRate(event.target.value);
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
        <Button onClick={() => void submit()} disabled={pending}>
          {pending ? "Saving…" : "Save earning rate"}
        </Button>
      </div>
    </div>
  );
}
