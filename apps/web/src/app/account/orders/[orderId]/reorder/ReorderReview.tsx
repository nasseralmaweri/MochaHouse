"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type {
  ReorderPreparation,
  ReorderPreparedItem,
} from "@mocha-house/contracts";
import { useCart } from "@/lib/cart/store";
import { formatPrice } from "@/lib/money";
import { Card } from "@/components/Card";
import { BackLink } from "@/components/BackLink";

export function ReorderReview({
  preparation,
}: {
  preparation: ReorderPreparation;
}) {
  const router = useRouter();
  const cart = useCart();
  const [confirmingReplace, setConfirmingReplace] = useState(false);

  const restorable = preparation.items.filter(
    (item) => item.status !== "UNAVAILABLE",
  );
  const unavailable = preparation.items.filter(
    (item) => item.status === "UNAVAILABLE",
  );

  // --- Location / nothing-restorable case ---------------------------------
  if (preparation.status === "UNAVAILABLE") {
    const locationIssue = preparation.issues[0];
    return (
      <div className="flex flex-col gap-4">
        <Card tone="subtle" className="text-sm text-status-warning">
          {locationIssue
            ? locationIssue.message
            : "None of the items from this order can be reordered right now."}
        </Card>

        {unavailable.length > 0 ? (
          <UnavailableList items={unavailable} />
        ) : null}

        <div className="flex flex-col gap-2">
          <Link
            href="/order/location"
            className="flex min-h-11 items-center justify-between rounded-xl border border-border-default bg-surface-card px-4 py-3 text-sm font-medium text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            Choose another location to order from
            <span aria-hidden="true">→</span>
          </Link>
          <p className="text-xs text-text-muted">
            We won&apos;t move this order to a different store automatically —
            prices and the menu can differ by location.
          </p>
        </div>
      </div>
    );
  }

  // --- Restorable case ---------------------------------------------------
  const priceChanged =
    preparation.currentEstimatedSubtotal !== preparation.historicalTotal ||
    preparation.items.some((item) =>
      item.issues.some((issue) => issue.code === "PRICE_CHANGED"),
    );
  const currency = restorable[0]?.currency ?? "USD";
  const cartHasItems = cart.isHydrated && cart.lines.length > 0;
  const differentLocation =
    cartHasItems && cart.locationId !== preparation.location.id;

  function rebuildCart() {
    cart.replaceCart({
      locationId: preparation.location.id,
      locationName: preparation.location.name,
      lines: restorable.map((item) => ({
        productId: item.productId,
        productName: item.productName,
        currency: item.currency,
        menuId: preparation.menuId ?? "",
        quantity: item.quantity,
        selections: item.selections,
        unitPriceAtAdd: item.currentUnitPrice ?? 0,
      })),
    });
    router.push("/order/cart");
  }

  function handlePrimary() {
    if (cartHasItems) {
      setConfirmingReplace(true);
      return;
    }
    rebuildCart();
  }

  const needsCustomizationCount = restorable.filter(
    (item) => item.needsCustomization,
  ).length;

  return (
    <div className="flex flex-col gap-5">
      {preparation.status === "READY" ? (
        <p className="text-sm text-text-secondary">
          Everything from this order is still available. Review today&apos;s
          prices below.
        </p>
      ) : (
        <p className="text-sm text-text-secondary">
          Some things have changed since your last order. Here&apos;s what we
          can bring back.
        </p>
      )}

      {priceChanged ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          Prices have changed since your previous order. Your cart will use
          today&apos;s prices.
        </Card>
      ) : null}

      <ul className="flex flex-col gap-3">
        {restorable.map((item, index) => (
          <li key={index}>
            <RestorableItemCard item={item} currency={currency} />
          </li>
        ))}
      </ul>

      {unavailable.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Not added
          </p>
          <UnavailableList items={unavailable} />
        </div>
      ) : null}

      <div className="flex flex-col gap-1 border-t border-border-default pt-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-text-secondary">Previous order total</span>
          <span className="text-text-muted line-through">
            {formatPrice(preparation.historicalTotal, currency)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="font-semibold text-text-primary">
            Estimated total today
          </span>
          <span className="text-lg font-semibold text-text-primary">
            {formatPrice(preparation.currentEstimatedSubtotal, currency)}
          </span>
        </div>
        <p className="text-xs text-text-muted">
          Final pricing is confirmed at checkout.
        </p>
      </div>

      {needsCustomizationCount > 0 ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          {needsCustomizationCount === 1 ? "One item needs" : "Some items need"}{" "}
          a choice before checkout — you can set that on the next screen.
        </Card>
      ) : null}

      {confirmingReplace ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border-default bg-surface-subtle px-4 py-3">
          <p className="text-sm text-text-secondary">
            Your cart has {cart.itemCount}{" "}
            {cart.itemCount === 1 ? "item" : "items"}
            {differentLocation && cart.locationName
              ? ` from ${cart.locationName}`
              : ""}
            . Replacing will clear{" "}
            {cart.itemCount === 1 ? "it" : "them"}.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={rebuildCart}
              className="flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-2 text-sm font-semibold text-status-success"
            >
              Replace cart and continue
            </button>
            <BackLink href="/order/cart">Keep my current cart</BackLink>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={handlePrimary}
          disabled={!cart.isHydrated || restorable.length === 0}
          className="flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-3 text-base font-semibold text-status-success disabled:bg-surface-subtle disabled:text-text-muted"
        >
          {cartHasItems
            ? "Replace cart with this order"
            : `Add ${restorable.length} ${
                restorable.length === 1 ? "item" : "items"
              } to cart`}
        </button>
      )}
    </div>
  );
}

function RestorableItemCard({
  item,
  currency,
}: {
  item: ReorderPreparedItem;
  currency: string;
}) {
  return (
    <Card
      tone={item.issues.length > 0 ? "subtle" : "default"}
      className="flex flex-col gap-2"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-base font-medium text-text-primary">
            {item.quantity}× {item.productName}
          </span>
          {item.selections.length > 0 ? (
            <span className="text-sm text-text-secondary">
              {item.selections
                .map((s) => `${s.groupName}: ${s.optionNames.join(", ")}`)
                .join(" · ")}
            </span>
          ) : null}
        </div>
        {item.currentLineSubtotal !== undefined ? (
          <span className="shrink-0 text-base font-semibold text-text-primary">
            {formatPrice(item.currentLineSubtotal, currency)}
          </span>
        ) : null}
      </div>

      {item.issues.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {item.issues.map((issue, index) => (
            <li
              key={index}
              className="rounded-lg bg-status-warning/10 px-3 py-2 text-xs font-medium text-status-warning"
            >
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function UnavailableList({ items }: { items: ReorderPreparedItem[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item, index) => (
        <li key={index}>
          <Card tone="subtle" className="flex flex-col gap-1">
            <span className="text-sm font-medium text-text-muted line-through">
              {item.quantity}× {item.productName}
            </span>
            <span className="text-xs text-text-muted">
              {item.issues[0]?.message ??
                "This item can't be reordered right now."}
            </span>
          </Card>
        </li>
      ))}
    </ul>
  );
}
