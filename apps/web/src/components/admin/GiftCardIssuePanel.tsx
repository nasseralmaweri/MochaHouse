"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { issueGiftCardFromBrowser } from "@/lib/api-client";
import { prepareIssue } from "@/lib/admin/gift-cards";
import { formatPrice } from "@/lib/money";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";

// HQ gift-card issuance (Milestone 7F). Rendered only for `giftcards.manage`.
// The API validates the $0.01–$2,000.00 range and writes the ISSUANCE
// ledger entry + audit event. The full code comes back exactly once — it is
// shown here and can never be retrieved again.
export function GiftCardIssuePanel() {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<
    { code: string; balanceMinorUnits: number; currency: string; id: string } | null
  >(null);

  async function submit() {
    setError(null);
    const prepared = prepareIssue(amount);
    if (!prepared.ok) {
      setError(prepared.error);
      return;
    }

    setPending(true);
    const result = await issueGiftCardFromBrowser(prepared.value);
    setPending(false);

    if (result.outcome === "success") {
      setIssued({
        code: result.data.code,
        balanceMinorUnits: result.data.giftCard.balanceMinorUnits,
        currency: result.data.giftCard.currency,
        id: result.data.giftCard.id,
      });
      setAmount("");
      router.refresh();
      return;
    }
    if (result.outcome === "forbidden") {
      setError("You don't have permission to issue gift cards.");
    } else if (result.outcome === "not-found") {
      setError("Couldn't issue that gift card. Please try again.");
    } else {
      // invalid / conflict / error all carry a business-safe message.
      setError(result.message);
    }
  }

  if (issued) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-status-success/40 bg-status-success/5 px-4 py-4">
        <p className="text-sm font-semibold text-text-primary">
          Gift card issued —{" "}
          {formatPrice(issued.balanceMinorUnits, issued.currency)}
        </p>
        <p className="text-sm text-text-secondary">
          Give the recipient this code now. It will not be shown again.
        </p>
        <p className="select-all rounded-lg border border-border-default bg-surface-card px-3 py-2 font-mono text-lg tracking-widest text-text-primary">
          {issued.code}
        </p>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              router.push(`/admin/gift-cards?selected=${issued.id}`);
            }}
          >
            View gift card
          </Button>
          <Button variant="secondary" onClick={() => setIssued(null)}>
            Issue another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex max-w-md flex-col gap-3">
      <FormField
        label="Gift-card value"
        htmlFor="gift-card-value"
        hint="A dollar amount like 25 or 50.00, up to $2,000.00."
      >
        <input
          id="gift-card-value"
          inputMode="decimal"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
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

      <div>
        <Button onClick={() => void submit()} disabled={pending}>
          {pending ? "Issuing…" : "Issue gift card"}
        </Button>
      </div>
    </div>
  );
}
