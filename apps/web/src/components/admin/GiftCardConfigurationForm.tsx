"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { GiftCardConfiguration } from "@mocha-house/contracts";
import { updateGiftCardConfigurationFromBrowser } from "@/lib/api-client";
import { prepareConfiguration } from "@/lib/admin/gift-cards";
import { centsToDollarInput } from "@/lib/money";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";

// HQ gift-card purchasing configuration (Milestone 7F). The API
// (`giftcards.configure`, CORPORATE-only) validates every rule and audits
// the change. Nothing in 7F consumes this — it is stored for the future
// customer-purchasing slice.
export function GiftCardConfigurationForm({
  configuration,
}: {
  configuration: GiftCardConfiguration;
}) {
  const router = useRouter();
  const [presetInputs, setPresetInputs] = useState<string[]>(() =>
    configuration.presetAmountsMinorUnits.length > 0
      ? configuration.presetAmountsMinorUnits.map((c) => centsToDollarInput(c))
      : [""],
  );
  const [customAmountEnabled, setCustomAmountEnabled] = useState(
    configuration.customAmountEnabled,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function setPresetAt(index: number, value: string) {
    setPresetInputs((current) =>
      current.map((entry, i) => (i === index ? value : entry)),
    );
    setError(null);
  }

  async function submit() {
    setError(null);
    setNotice(null);

    const prepared = prepareConfiguration({ presetInputs, customAmountEnabled });
    if (!prepared.ok) {
      setError(prepared.error);
      return;
    }

    setPending(true);
    const result = await updateGiftCardConfigurationFromBrowser(prepared.value);
    setPending(false);

    if (result.outcome === "success") {
      setPresetInputs(
        result.data.presetAmountsMinorUnits.map(
          (c) => centsToDollarInput(c),
        ),
      );
      setCustomAmountEnabled(result.data.customAmountEnabled);
      setNotice("Gift-card purchasing configuration saved.");
      router.refresh();
      return;
    }
    if (result.outcome === "forbidden") {
      setError("You don't have permission to change this configuration.");
    } else if (result.outcome === "not-found") {
      setError("The gift-card configuration could not be found.");
    } else {
      setError(result.message);
    }
  }

  return (
    <div className="flex max-w-md flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-text-primary">
          Preset purchase amounts
        </legend>
        <p className="text-xs text-text-muted">
          Dollar amounts, up to $2,000.00 each. These are suggestions a
          customer will later be able to pick from.
        </p>
        {presetInputs.map((value, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              inputMode="decimal"
              aria-label={`Preset amount ${index + 1}`}
              value={value}
              onChange={(event) => setPresetAt(index, event.target.value)}
              className={ADMIN_FIELD_CLASS}
            />
            {presetInputs.length > 1 ? (
              <button
                type="button"
                onClick={() => {
                  setPresetInputs((current) =>
                    current.filter((_, i) => i !== index),
                  );
                  setError(null);
                }}
                className="text-sm text-text-secondary hover:text-text-primary"
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
        <div>
          <Button
            variant="secondary"
            onClick={() => setPresetInputs((current) => [...current, ""])}
          >
            Add amount
          </Button>
        </div>
      </fieldset>

      <FormField label="Custom amounts" htmlFor="gc-custom-enabled">
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            id="gc-custom-enabled"
            type="checkbox"
            checked={customAmountEnabled}
            onChange={(event) => {
              setCustomAmountEnabled(event.target.checked);
              setError(null);
            }}
          />
          Let customers enter their own gift-card amount
        </label>
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
          {pending ? "Saving…" : "Save configuration"}
        </Button>
      </div>
    </div>
  );
}
