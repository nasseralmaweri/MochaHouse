"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adjustMochaBeansFromBrowser } from "@/lib/api-client";
import {
  prepareAdjustment,
  wouldGoNegative,
  type AdjustmentDirection,
  type AdjustmentFormValues,
} from "@/lib/admin/loyalty-adjustment";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";

// The HQ manual Mocha Bean adjustment form (Milestone 7A). Rendered only
// when the viewer holds `loyalty.adjust`. The API is the authority — it
// enforces the required reason, the operationKey idempotency and the
// no-negative-balance rule; this island collects the input, warns early,
// and surfaces the result.
//
// `operationKey` is minted once per attempt and REUSED across a retry of
// the same submission (so a lost-response retry is idempotent), then
// rotated after a success.
export function MochaBeanAdjustForm({
  customerId,
  currentBalance,
}: {
  customerId: string;
  currentBalance: number;
}) {
  const router = useRouter();

  const [direction, setDirection] = useState<AdjustmentDirection>("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [operationKey, setOperationKey] = useState(() =>
    globalThis.crypto.randomUUID(),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const values: AdjustmentFormValues = { direction, amount, reason };

  function resetAfterSuccess() {
    setAmount("");
    setReason("");
    setOperationKey(globalThis.crypto.randomUUID());
  }

  async function submit() {
    setError(null);
    setNotice(null);

    const prepared = prepareAdjustment(values, operationKey);
    if (!prepared.ok) {
      setError(prepared.error);
      return;
    }
    if (wouldGoNegative(currentBalance, prepared.value.deltaBeans)) {
      setError(
        `That deduction is more than the current balance of ${currentBalance} Mocha Beans.`,
      );
      return;
    }

    setPending(true);
    const result = await adjustMochaBeansFromBrowser(customerId, prepared.value);
    setPending(false);

    if (result.outcome === "success") {
      setNotice(
        `Balance is now ${result.detail.customer.balance} Mocha Beans.`,
      );
      resetAfterSuccess();
      // router.refresh() re-runs the server component for the current URL,
      // so the selected customer and their ledger update in place.
      router.refresh();
      return;
    }

    if (result.outcome === "forbidden") {
      setError("You don't have permission to adjust Mocha Beans.");
    } else if (result.outcome === "not-found") {
      setError("This customer no longer exists.");
    } else {
      // invalid / conflict / error all carry a business-safe message.
      setError(result.message);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border-default bg-surface-subtle px-4 py-4">
      <p className="text-sm font-semibold text-text-primary">
        Adjust Mocha Beans
      </p>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-text-primary">
          Direction
        </legend>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="radio"
            name="direction"
            checked={direction === "add"}
            onChange={() => {
              setDirection("add");
              setError(null);
            }}
          />
          Add Beans
        </label>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="radio"
            name="direction"
            checked={direction === "deduct"}
            onChange={() => {
              setDirection("deduct");
              setError(null);
            }}
          />
          Deduct Beans
        </label>
      </fieldset>

      <FormField label="Amount (Mocha Beans)" htmlFor="bean-amount">
        <input
          id="bean-amount"
          inputMode="numeric"
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
        htmlFor="bean-reason"
        hint="Recorded in the Bean ledger and the internal audit log."
      >
        <textarea
          id="bean-reason"
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
          {pending ? "Working…" : "Apply adjustment"}
        </Button>
      </div>
    </div>
  );
}
