"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  CheckoutQuoteResponse,
  CheckoutRequest,
  CouponQuoteStatus,
  LocationMenuResponse,
} from "@mocha-house/contracts";
import { priceCart } from "@mocha-house/domain";
import { useCart } from "@/lib/cart/store";
import {
  getCheckoutQuoteFromBrowser,
  getLocationMenuFromBrowser,
  submitCheckoutFromBrowser,
} from "@/lib/api-client";
import { formatPrice } from "@/lib/money";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";

const inputClassName =
  "rounded-xl border border-border-default bg-surface-card px-4 py-3 text-base text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

const COUPON_MESSAGE: Record<CouponQuoteStatus, string> = {
  applied: "Coupon applied.",
  invalid: "We couldn't find that coupon.",
  inactive: "That coupon is no longer active.",
  not_started: "That coupon isn't available yet.",
  expired: "That coupon has expired.",
  wrong_location: "That coupon isn't valid at this location.",
  not_applicable: "That coupon doesn't apply to anything in your cart.",
  minimum_not_met: "Your order doesn't reach this coupon's minimum.",
  usage_limit_reached: "This coupon has reached its redemption limit.",
  sign_in_required: "Sign in to use this coupon.",
};

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
  // Milestone 7E — the server-authoritative pricing quote (regular
  // Promotion/Coupon + Mocha Bean rewards + total). Recomputed whenever the
  // cart, the applied coupon, or the selected reward changes.
  const [quote, setQuote] = useState<CheckoutQuoteResponse | null>(null);
  const [selectedRewardId, setSelectedRewardId] = useState<string | null>(null);
  const [couponDraft, setCouponDraft] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<string | null>(null);

  const inFlightRef = useRef(false);
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

  const cartLinesKey = cart.isHydrated
    ? JSON.stringify(
        cart.lines.map((line) => ({
          p: line.productId,
          q: line.quantity,
          s: line.selections.map((sel) => ({
            g: sel.groupId,
            o: [...sel.optionIds].sort(),
          })),
        })),
      )
    : "";

  useEffect(() => {
    if (!cart.isHydrated || !cart.locationId || cart.lines.length === 0) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    getCheckoutQuoteFromBrowser({
      locationId: cart.locationId,
      lines: cart.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        selections: line.selections.map((s) => ({
          groupId: s.groupId,
          optionIds: s.optionIds,
        })),
      })),
      couponCode: appliedCoupon,
      loyaltyRewardId: selectedRewardId,
    })
      .then((result) => {
        if (cancelled) return;
        setQuote(result);
        // Drop a stale / now-unaffordable reward selection.
        setSelectedRewardId((current) =>
          current !== null &&
          result?.rewards.some((r) => r.rewardId === current && r.canAfford)
            ? current
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setQuote(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.isHydrated, cart.locationId, cartLinesKey, appliedCoupon, selectedRewardId]);

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

  const currency = quote?.currency ?? (priced?.ok ? priced.currency : "USD");
  const subtotal = quote?.subtotal ?? (priced?.ok ? priced.subtotal : 0);
  const regularDiscount = quote?.regularDiscount ?? null;
  const rewardDiscount = quote?.rewardDiscountMinorUnits ?? 0;
  const total =
    quote?.total ??
    subtotal -
      (regularDiscount?.discountMinorUnits ?? 0) -
      rewardDiscount;
  const rewardOptions = quote?.rewards ?? [];
  const selectedReward =
    selectedRewardId !== null
      ? (rewardOptions.find((r) => r.rewardId === selectedRewardId) ?? null)
      : null;
  const couponNote =
    quote?.couponStatus !== null && quote?.couponStatus !== undefined
      ? COUPON_MESSAGE[quote.couponStatus]
      : null;
  const couponApplied = quote?.couponStatus === "applied";

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
      loyaltyRewardId: selectedRewardId,
      couponCode: appliedCoupon,
    };

    const result = await submitCheckoutFromBrowser(request);
    inFlightRef.current = false;
    setSubmitting(false);

    if (result.outcome === "success") {
      cart.clearCart();
      router.push(
        `/order/confirmation/${result.confirmation.orderId}?token=${result.confirmation.accessToken}`,
      );
      return;
    }

    if (result.outcome === "declined" || result.outcome === "failed") {
      rotateKeyOnNextSubmitRef.current = true;
    }
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
          <div className="flex flex-col gap-1 border-t border-border-default pt-2">
            <div className="flex items-center justify-between text-sm text-text-secondary">
              <span>Subtotal</span>
              <span>{formatPrice(subtotal, currency)}</span>
            </div>
            {regularDiscount ? (
              <div className="flex items-center justify-between text-sm text-status-success">
                <span>
                  {regularDiscount.source === "COUPON" ? "Coupon" : "Promotion"}
                  {" · "}
                  {regularDiscount.name}
                  {regularDiscount.discountType === "FREE_ITEM" &&
                  regularDiscount.freeItemName
                    ? ` (free ${regularDiscount.freeItemName})`
                    : ""}
                </span>
                <span>
                  −{formatPrice(regularDiscount.discountMinorUnits, currency)}
                </span>
              </div>
            ) : null}
            {selectedReward ? (
              <div className="flex items-center justify-between text-sm text-status-success">
                <span>Mocha Beans Reward · {selectedReward.name}</span>
                <span>−{formatPrice(rewardDiscount, currency)}</span>
              </div>
            ) : null}
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-text-primary">
                Total
              </span>
              <span className="text-lg font-semibold text-text-primary">
                {formatPrice(total, currency)}
              </span>
            </div>
            {selectedReward ? (
              <p className="text-xs text-text-muted">
                {selectedReward.beanCost} Mocha Beans will be used.
              </p>
            ) : null}
          </div>
        </Card>
      ) : null}

      {priced?.ok ? (
        <Card className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-text-primary">Coupon</span>
          {couponApplied && appliedCoupon ? (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-mono text-text-primary">{appliedCoupon}</span>
              <button
                type="button"
                onClick={() => {
                  setAppliedCoupon(null);
                  setCouponDraft("");
                }}
                className="text-xs font-medium text-text-primary underline underline-offset-2"
              >
                Remove
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                value={couponDraft}
                onChange={(e) => setCouponDraft(e.target.value.toUpperCase())}
                placeholder="Enter a code"
                className={`${inputClassName} flex-1 font-mono text-sm`}
              />
              <button
                type="button"
                disabled={couponDraft.trim().length === 0}
                onClick={() => setAppliedCoupon(couponDraft.trim())}
                className="rounded-xl bg-status-success/10 px-4 text-sm font-semibold text-status-success disabled:bg-surface-subtle disabled:text-text-muted"
              >
                Apply
              </button>
            </div>
          )}
          {couponNote && !couponApplied ? (
            <p className="text-xs text-status-warning">{couponNote}</p>
          ) : null}
        </Card>
      ) : null}

      {rewardOptions.length > 0 && priced?.ok ? (
        <Card className="flex flex-col gap-3">
          <span className="text-sm font-semibold text-text-primary">
            Use Mocha Beans
          </span>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input
                type="radio"
                name="loyalty-reward"
                checked={selectedRewardId === null}
                onChange={() => setSelectedRewardId(null)}
              />
              No reward
            </label>
            {rewardOptions.map((reward) => (
              <label
                key={reward.rewardId}
                className={`flex items-center justify-between gap-2 text-sm ${
                  reward.canAfford ? "text-text-primary" : "text-text-muted"
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="loyalty-reward"
                    disabled={!reward.canAfford}
                    checked={selectedRewardId === reward.rewardId}
                    onChange={() => setSelectedRewardId(reward.rewardId)}
                  />
                  {reward.name}
                  {reward.type === "FREE_ITEM" && reward.freeItemName ? (
                    <span className="text-xs text-text-muted">
                      (free {reward.freeItemName})
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs">
                  {reward.beanCost} Beans
                  {reward.canAfford ? "" : " · not enough"}
                </span>
              </label>
            ))}
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
              ? `Place order — ${formatPrice(total, currency)}`
              : "Place order"}
        </button>
      </form>

      <BackLink href="/order/cart">Back to cart</BackLink>
    </main>
  );
}
