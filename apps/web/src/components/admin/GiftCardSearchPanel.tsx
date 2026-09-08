"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AdminGiftCard } from "@mocha-house/contracts";
import { searchGiftCardFromBrowser } from "@/lib/api-client";
import { normalizeGiftCardQuery } from "@/lib/admin/gift-cards";
import { formatPrice } from "@/lib/money";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The HQ gift-card lookup (Milestone 7F). Exact match only — the secure
// code OR the internal id. The code is sent in the POST body (never a URL /
// query string); the selected card id then lives in the page URL so the
// detail view is refresh-safe.
export function GiftCardSearchPanel({
  selectedId,
}: {
  selectedId?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<AdminGiftCard[] | null>(null);

  async function submit() {
    setError(null);
    const normalized = normalizeGiftCardQuery(query);
    if (normalized.length === 0) {
      setError("Enter a gift-card code or id.");
      return;
    }

    const input = UUID_PATTERN.test(normalized)
      ? { giftCardId: normalized }
      : { code: normalized };

    setPending(true);
    const result = await searchGiftCardFromBrowser(input);
    setPending(false);

    if (result.outcome === "success") {
      setResults(result.data.giftCards);
      return;
    }
    setResults(null);
    if (result.outcome === "forbidden") {
      setError("You don't have permission to look up gift cards.");
    } else if (result.outcome === "invalid") {
      setError(result.message);
    } else {
      setError("Couldn't run that search just now. Please try again.");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormField label="Gift-card code or id" htmlFor="gift-card-query">
          <input
            id="gift-card-query"
            value={query}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setError(null);
            }}
            className={ADMIN_FIELD_CLASS}
          />
        </FormField>
        <Button type="submit" disabled={pending}>
          {pending ? "Searching…" : "Search"}
        </Button>
      </form>

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}

      {results !== null ? (
        results.length === 0 ? (
          <p className="text-sm text-text-muted">
            No gift card matched. Check the code or id and try again.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {results.map((card) => {
              const isSelected = card.id === selectedId;
              return (
                <li key={card.id}>
                  <Link
                    href={{
                      pathname: "/admin/gift-cards",
                      query: { selected: card.id },
                    }}
                    aria-current={isSelected ? "true" : undefined}
                    className={`flex items-center justify-between gap-4 rounded-xl border border-border-default px-4 py-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                      isSelected
                        ? "bg-surface-subtle"
                        : "bg-surface-card hover:bg-surface-subtle"
                    }`}
                  >
                    <span className="flex flex-col">
                      <span className="font-mono font-medium tracking-wider text-text-primary">
                        {card.maskedCode}
                      </span>
                      <span className="text-xs text-text-muted">
                        {card.id} ·{" "}
                        {card.status === "ACTIVE" ? "Active" : "Inactive"}
                      </span>
                    </span>
                    <span className="shrink-0 font-semibold text-text-primary">
                      {formatPrice(card.balanceMinorUnits, card.currency)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}
