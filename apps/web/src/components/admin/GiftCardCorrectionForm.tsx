"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { correctGiftCardBalanceFromBrowser } from "@/lib/api-client";
import {
  correctionWouldBeOutOfRange,
  prepareCorrection,
  type CorrectionDirection,
  type CorrectionFormValues,
} from "@/lib/admin/gift-cards";
import { formatPrice } from "@/lib/money";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";

// The HQ authorized manual balance correction (Milestone 7F). Rendered only
// for `giftcards.manage`. The API is the authority — it enforces the
// required reason, the operationKey idempotency and the [0, $2,000.00]
// bounds; this island collects input, warns early, and surfaces the result.
// `operationKey` is minted once per attempt and REUSED across a retry of
// the same submission, then rotated after a success.
export function GiftCardCorrectionForm({
  giftCardId,
  currentBalanceMinorUnits,
  currency,
}: {
  giftCardId: string;
  currentBalanceMinorUnits: number;
  currency: string;
}) {
  const router = useRouter();
  const [direction, setDirection] = useState<CorrectionDirection>("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [operationKey, setOperationKey] = useState(() =>
    globalThis.crypto.randomUUID(),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const values: CorrectionFormValues = { direction, amount, reason };

  async function submit() {
    setError(null);
    setNotice(null);

    const prepared = prepareCorrection(values, operationKey);
    if (!prepared.ok) {
      setError(prepared.error);
      return;
    }
    if (
      correctionWouldBeOutOfRange(
        currentBalanceMinorUnits,
        prepared.value.deltaMinorUnits,
      )
    ) {
      setError(
        `That correction would take the balance outside $0.00–$2,000.00 (current balance ${formatPrice(
          currentBalanceMinorUnits,
          currency,
        )}).`,
      );
      return;
    }

    setPending(true);
    const result = await correctGiftCardBalanceFromBrowser(
      giftCardId,
      prepared.value,
    );
    setPending(false);

    if (result.outcome === "success") {
      setNotice(
        `Balance is now ${formatPrice(
          result.data.giftCard.balanceMinorUnits,
          result.data.giftCard.currency,
        )}.`,
      );
      setAmount("");
      setReason("");
      setOperationKey(globalThis.crypto.randomUUID());
      router.refresh();
      return;
    }

    if (result.outcome === "forbidden") {
      setError("You don't have permission to correct gift-card balances.");
    } else if (result.outcome === "not-found") {
      setError("This gift card no longer exists.");
    } else {
      // invalid / conflict / error all carry a business-safe message.
      setError(result.message);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border-default bg-surface-subtle px-4 py-4">
      <p className="text-sm font-semibold text-text-primary">
        Correct the balance
      </p>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-text-primary">
          Direction
        </legend>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="radio"
            name="gc-direction"
            checked={direction === "add"}
            onChange={() => {
              setDirection("add");
              setError(null);
            }}
          />
          Add value
        </label>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="radio"
            name="gc-direction"
            checked={direction === "deduct"}
            onChange={() => {
              setDirection("deduct");
              setError(null);
            }}
          />
          Deduct value
        </label>
      </fieldset>

      <FormField label="Amount" htmlFor="gc-correction-amount">
        <input
          id="gc-correction-amount"
          inputMode="decimal"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
            setError(null);
          }}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

      <FormField
        label="Reason"
        htmlFor="gc-correction-reason"
        hint="Recorded in the gift-card ledger and the internal audit log."
      >
        <textarea
          id="gc-correction-reason"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setError(null);
          }}
          rows={2}
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
          {pending ? "Working…" : "Apply correction"}
        </Button>
      </div>
    </div>
  );
}
