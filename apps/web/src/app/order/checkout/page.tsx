"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CheckoutRequest, LocationMenuResponse } from "@mocha-house/contracts";
import { priceCart } from "@mocha-house/domain";
import { useCart } from "@/lib/cart/store";
import { getLocationMenuFromBrowser, submitCheckoutFromBrowser } from "@/lib/api-client";
import { formatPrice } from "@/lib/money";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";

const inputClassName =
  "rounded-xl border border-border-default bg-surface-card px-4 py-3 text-base text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export default function CheckoutPage() {
  const router = useRouter();
  const cart = useCart();
  const [menu, setMenu] = useState<LocationMenuResponse | null>(null);
  const [menuFailed, setMenuFailed] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Synchronous guard against a double-click firing two submissions before
  // React re-renders with `submitting`/disabled — the disabled attribute
  // alone isn't fast enough to rule that race out.
  const inFlightRef = useRef(false);
  // One idempotency key persists across retries until this attempt reaches
  // a *definitive* server outcome. A network failure, timeout, or lost
  // response is ambiguous — the request may have actually reached the
  // server and charged — so retrying must reuse the same key rather than
  // risk a second charge. Only an authoritative DECLINED/FAILED result (or
  // a pre-payment validation error, which never created a payment attempt
  // at all) makes this attempt terminal and safe to abandon; the next
  // explicit submit then mints a fresh key for a genuinely new attempt.
  const idempotencyKeyRef = useRef<string | null>(null);
  const rotateKeyOnNextSubmitRef = useRef(true);

  useEffect(() => {
    if (!cart.isHydrated || !cart.locationId) {
      return;
    }
    let cancelled = false;
    getLocationMenuFromBrowser(cart.locationId)
      .then((result) => {
        if (!cancelled) setMenu(result);
      })
      .catch(() => {
        if (!cancelled) setMenuFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cart.isHydrated, cart.locationId]);

  if (!cart.isHydrated) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title="Checkout" />
      </main>
    );
  }

  if (cart.lines.length === 0) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title="Checkout" subtitle="Your cart is empty." />
        <BackLink href="/order/location">Start an order</BackLink>
      </main>
    );
  }

  const menuMatchesCart = menu !== null && menu.location.id === cart.locationId;
  // Preview only — this is the exact same authoritative repricing function
  // the backend runs, so what's shown here is what checkout will charge as
  // long as nothing changes between now and submission. The backend
  // re-runs this independently either way; a stale/mismatched preview here
  // can never result in an incorrect charge, only a stale preview.
  const priced = menuMatchesCart
    ? priceCart(
        menu,
        cart.lines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          selections: line.selections.map((s) => ({
            groupId: s.groupId,
            optionIds: s.optionIds,
          })),
        })),
      )
    : null;
  const cartBlocked = priced !== null && !priced.ok;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setSubmitting(true);
    setSubmitError(null);

    if (rotateKeyOnNextSubmitRef.current || !idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
      rotateKeyOnNextSubmitRef.current = false;
    }

    const request: CheckoutRequest = {
      idempotencyKey: idempotencyKeyRef.current,
      locationId: cart.locationId as string,
      guest: {
        name: guestName.trim(),
        phone: guestPhone.trim(),
        email: guestEmail.trim() || null,
      },
      lines: cart.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        selections: line.selections.map((s) => ({
          groupId: s.groupId,
          optionIds: s.optionIds,
        })),
      })),
    };

    const result = await submitCheckoutFromBrowser(request);
    inFlightRef.current = false;
    setSubmitting(false);

    if (result.outcome === "success") {
      // Cart is only ever cleared on confirmed success — every failure
      // path below leaves it untouched so the customer can retry.
      cart.clearCart();
      router.push(
        `/order/confirmation/${result.confirmation.orderId}?token=${result.confirmation.accessToken}`,
      );
      return;
    }

    if (result.outcome === "declined" || result.outcome === "failed") {
      // Definitive server outcome — this attempt is over. The next
      // explicit submit is a genuinely new attempt and gets a fresh key.
      rotateKeyOnNextSubmitRef.current = true;
    }
    // Otherwise (network-error / invalid / conflict): the outcome is
    // ambiguous or nothing was charged yet, so the same key carries over
    // to the next retry unchanged.

    setSubmitError(result.message);
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader title="Checkout" subtitle={cart.locationName ?? undefined} />

      {menuFailed ? (
        <Card tone="subtle" className="text-sm text-text-muted">
          We couldn&apos;t confirm current pricing. You can still try to place
          your order — it will be validated when you submit.
        </Card>
      ) : null}

      {cartBlocked ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          Something in your cart needs attention before you can check out.{" "}
          <BackLink href="/order/cart">Review your cart</BackLink>
        </Card>
      ) : null}

      {priced?.ok ? (
        <Card className="flex flex-col gap-2">
          <ul className="flex flex-col gap-2">
            {priced.lines.map((line, index) => (
              <li key={index} className="flex items-start justify-between gap-4 text-sm">
                <span className="text-text-primary">
                  {line.quantity}× {line.productName}
                  {line.selections.length > 0 ? (
                    <span className="block text-xs text-text-muted">
                      {line.selections
                        .map((s) => s.optionNames.join(", "))
                        .join(" · ")}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-text-secondary">
                  {formatPrice(line.lineTotal, line.currency)}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-border-default pt-2">
            <span className="text-sm font-semibold text-text-primary">Total</span>
            <span className="text-lg font-semibold text-text-primary">
              {formatPrice(priced.subtotal, priced.currency)}
            </span>
          </div>
        </Card>
      ) : null}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm text-text-secondary">
          Name
          <input
            required
            autoComplete="name"
            value={guestName}
            onChange={(event) => setGuestName(event.target.value)}
            className={inputClassName}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-text-secondary">
          Phone
          <input
            required
            type="tel"
            autoComplete="tel"
            value={guestPhone}
            onChange={(event) => setGuestPhone(event.target.value)}
            className={inputClassName}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-text-secondary">
          Email (optional)
          <input
            type="email"
            autoComplete="email"
            value={guestEmail}
            onChange={(event) => setGuestEmail(event.target.value)}
            className={inputClassName}
          />
        </label>

        {submitError ? (
          <Card tone="subtle" className="text-sm text-status-warning">
            {submitError}
          </Card>
        ) : null}

        <button
          type="submit"
          disabled={submitting || cartBlocked}
          className="flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-3 text-base font-semibold text-status-success disabled:bg-surface-subtle disabled:text-text-muted"
        >
          {submitting
            ? "Placing order…"
            : priced?.ok
              ? `Place order — ${formatPrice(priced.subtotal, priced.currency)}`
              : "Place order"}
        </button>
      </form>

      <BackLink href="/order/cart">Back to cart</BackLink>
    </main>
  );
}
