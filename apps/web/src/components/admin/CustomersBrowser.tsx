"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AdminCustomerSummary } from "@mocha-house/contracts";
import { listAdminCustomersFromBrowser } from "@/lib/api-client";
import {
  customerDisplayName,
  customerStatusLabel,
  customerStatusTone,
  emailVerifiedLabel,
  formatCrmDate,
} from "@/lib/admin/crm";
import { Card } from "@/components/Card";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS } from "./form";
import { AdminEmptyState, AdminErrorState } from "./states";

// Admin → Customers directory (Milestone 8A). Server-authorised and
// server-loaded for page 1; this island runs the debounced search and the
// cursor "load more". Read-only — a row links to the detail page.
export function CustomersBrowser({
  initial,
}: {
  initial: { customers: AdminCustomerSummary[]; nextCursor: string | null };
}) {
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState(initial.customers);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  // Debounced re-search whenever the query changes (empty query -> the full
  // directory again).
  useEffect(() => {
    const id = ++requestId.current;
    const handle = setTimeout(async () => {
      setPending(true);
      setError(null);
      const result = await listAdminCustomersFromBrowser({ q: query });
      if (id !== requestId.current) {
        return;
      }
      setPending(false);
      if (result.outcome === "forbidden") {
        setError("Your access to the customer directory was removed.");
        return;
      }
      if (result.outcome === "error") {
        setError(result.message);
        return;
      }
      setCustomers(result.data.customers);
      setCursor(result.data.nextCursor);
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  async function loadMore() {
    if (!cursor) {
      return;
    }
    setPending(true);
    setError(null);
    const result = await listAdminCustomersFromBrowser({
      q: query,
      cursor,
    });
    setPending(false);
    if (result.outcome !== "success") {
      setError(
        result.outcome === "forbidden"
          ? "Your access to the customer directory was removed."
          : result.message,
      );
      return;
    }
    setCustomers((prev) => [...prev, ...result.data.customers]);
    setCursor(result.data.nextCursor);
  }

  return (
    <div className="flex flex-col gap-4">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by name, email, or customer id"
        aria-label="Search customers"
        className={`${ADMIN_FIELD_CLASS} min-h-11`}
      />

      {error ? <AdminErrorState description={error} /> : null}

      {customers.length === 0 && !pending && !error ? (
        <AdminEmptyState
          title="No customers found"
          description={
            query.trim().length > 0
              ? "No customer matches that search."
              : "There are no customer accounts yet."
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {customers.map((customer) => (
            <li key={customer.id}>
              <Link
                href={`/admin/customers/${customer.id}`}
                className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <Card className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {customerDisplayName(customer)}
                    </span>
                    <span className="truncate text-xs text-text-secondary">
                      {customer.email ?? "No email on file"} ·{" "}
                      {emailVerifiedLabel(customer.emailVerified)} · joined{" "}
                      {formatCrmDate(customer.createdAt)}
                    </span>
                  </div>
                  <StatusBadge
                    label={customerStatusLabel(customer.status)}
                    tone={customerStatusTone(customer.status)}
                  />
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {cursor ? (
        <Button
          variant="secondary"
          onClick={loadMore}
          disabled={pending}
          className="self-start"
        >
          {pending ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
