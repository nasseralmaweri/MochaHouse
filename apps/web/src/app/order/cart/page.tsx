"use client";

import { useEffect, useMemo, useState } from "react";
import type { LocationMenuResponse } from "@mocha-house/contracts";
import { useCart, type CartLine } from "@/lib/cart/store";
import { getLocationMenuFromBrowser } from "@/lib/api-client";
import { formatPrice } from "@/lib/money";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";
import { QuantityStepper } from "@/components/QuantityStepper";

type LineStatus =
  | { kind: "ok"; unitPrice: number }
  | { kind: "price-changed"; unitPrice: number }
  | { kind: "modifiers-changed"; unitPrice: number }
  | { kind: "unavailable" }
  | { kind: "removed" };

export default function OrderCartPage() {
  const cart = useCart();
  const [menu, setMenu] = useState<LocationMenuResponse | null>(null);
  // Tracks which locationId a fetch failure applies to (rather than a bare
  // boolean) so a later location change naturally clears the old failure
  // without needing a synchronous reset.
  const [failedLocationId, setFailedLocationId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    // A null locationId only ever occurs with an empty cart (the store
    // clears it when the last line is removed), and the empty-cart render
    // branch below never reads `menu` — so there is nothing to revalidate.
    if (!cart.isHydrated || !cart.locationId) {
      return;
    }

    let cancelled = false;

    getLocationMenuFromBrowser(cart.locationId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setMenu(result);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setFailedLocationId(cart.locationId);
      });

    return () => {
      cancelled = true;
    };
  }, [cart.isHydrated, cart.locationId]);

  // Guards against briefly using a previous location's cached menu to
  // validate the current cart if the location changes without a remount.
  const menuMatchesCart =
    menu !== null && cart.locationId !== null && menu.location.id === cart.locationId;
  const effectiveMenu = menuMatchesCart ? menu : null;
  const revalidationFailed =
    failedLocationId !== null && failedLocationId === cart.locationId;
  const isRevalidating =
    cart.isHydrated &&
    cart.locationId !== null &&
    !menuMatchesCart &&
    !revalidationFailed;

  const lineStatuses = useMemo(() => {
    const statuses = new Map<string, LineStatus>();

    if (!effectiveMenu) {
      return statuses;
    }

    for (const line of cart.lines) {
      const menuProduct = effectiveMenu.menu.products.find(
        (product) => product.product.id === line.productId,
      );

      if (!menuProduct || menuProduct.effectivePrice === null) {
        statuses.set(line.lineId, {
          kind: !menuProduct ? "removed" : "unavailable",
        });
        continue;
      }

      if (!menuProduct.isAvailable) {
        statuses.set(line.lineId, { kind: "unavailable" });
        continue;
      }

      let unitPrice = menuProduct.effectivePrice;
      let modifiersChanged = false;

      for (const selection of line.selections) {
        const currentGroup = menuProduct.modifierGroups.find(
          (group) => group.id === selection.groupId,
        );

        if (!currentGroup) {
          modifiersChanged = true;
          continue;
        }

        for (const optionId of selection.optionIds) {
          const currentOption = currentGroup.options.find(
            (option) => option.id === optionId,
          );

          if (!currentOption) {
            modifiersChanged = true;
            continue;
          }

          unitPrice += currentOption.priceAdjustment;
        }
      }

      if (modifiersChanged) {
        statuses.set(line.lineId, { kind: "modifiers-changed", unitPrice });
      } else if (unitPrice !== line.unitPriceAtAdd) {
        statuses.set(line.lineId, { kind: "price-changed", unitPrice });
      } else {
        statuses.set(line.lineId, { kind: "ok", unitPrice });
      }
    }

    return statuses;
  }, [effectiveMenu, cart.lines]);

  const orderingDisabled = effectiveMenu
    ? !effectiveMenu.location.isDigitalOrderingEnabled
    : false;

  const subtotal = useMemo(() => {
    let sum = 0;
    for (const line of cart.lines) {
      const status = lineStatuses.get(line.lineId);
      // Only lines whose configuration is still fully valid count toward
      // the subtotal — unavailable/removed/modifiers-changed lines must be
      // fixed by the customer first, never silently priced or dropped.
      if (status?.kind === "ok" || status?.kind === "price-changed") {
        sum += status.unitPrice * line.quantity;
      }
    }
    return sum;
  }, [cart.lines, lineStatuses]);

  if (!cart.isHydrated) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title="Your cart" />
      </main>
    );
  }

  if (cart.lines.length === 0) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title="Your cart" subtitle="Your cart is empty." />
        <BackLink href="/order/location">Start an order</BackLink>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader title="Your cart" subtitle={cart.locationName ?? undefined} />

      {revalidationFailed ? (
        <Card tone="subtle" className="text-sm text-text-muted">
          We couldn&apos;t check current prices and availability. Your saved
          selections are shown below.
        </Card>
      ) : null}

      {orderingDisabled ? (
        <Card tone="subtle" className="text-sm text-text-muted">
          Online ordering isn&apos;t available at this location right now.
          You can still review your cart.
        </Card>
      ) : null}

      <ul className="flex flex-col gap-3">
        {cart.lines.map((line) => (
          <li key={line.lineId}>
            <CartLineCard
              line={line}
              status={lineStatuses.get(line.lineId)}
              locationId={cart.locationId as string}
              onQuantityChange={(quantity) =>
                cart.setLineQuantity(line.lineId, quantity)
              }
              onRemove={() => cart.removeLine(line.lineId)}
            />
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2 border-t border-border-default pt-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-secondary">Subtotal</span>
          <span className="text-lg font-semibold text-text-primary">
            {isRevalidating
              ? "…"
              : formatPrice(subtotal, cart.lines[0]?.currency ?? "USD")}
          </span>
        </div>
        <p className="text-xs text-text-muted">
          Final pricing is confirmed at checkout.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <BackLink href={`/order/menu?location=${cart.locationId}`}>
          Add more items
        </BackLink>
        <button
          type="button"
          onClick={cart.clearCart}
          className="text-sm font-medium text-text-muted underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Clear cart
        </button>
      </div>
    </main>
  );
}

function CartLineCard({
  line,
  status,
  locationId,
  onQuantityChange,
  onRemove,
}: {
  line: CartLine;
  status: LineStatus | undefined;
  locationId: string;
  onQuantityChange: (quantity: number) => void;
  onRemove: () => void;
}) {
  const needsAttention =
    status !== undefined &&
    status.kind !== "ok" &&
    status.kind !== "price-changed";

  const displayUnitPrice =
    status && "unitPrice" in status ? status.unitPrice : line.unitPriceAtAdd;

  return (
    <Card
      tone={needsAttention ? "subtle" : "default"}
      className="flex flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-base font-medium text-text-primary">
            {line.productName}
          </span>
          {line.selections.length > 0 ? (
            <span className="text-sm text-text-secondary">
              {line.selections
                .map(
                  (selection) =>
                    `${selection.groupName}: ${selection.optionNames.join(", ")}`,
                )
                .join(" · ")}
            </span>
          ) : null}
        </div>
        <span className="shrink-0 text-base font-semibold text-text-primary">
          {formatPrice(displayUnitPrice * line.quantity, line.currency)}
        </span>
      </div>

      {status ? (
        <LineStatusNotice
          status={status}
          priorUnitPrice={line.unitPriceAtAdd}
          currency={line.currency}
        />
      ) : null}

      <div className="flex items-center justify-between gap-4">
        <QuantityStepper quantity={line.quantity} onChange={onQuantityChange} label="" />
        <div className="flex items-center gap-4">
          <BackLink
            href={`/order/product/${line.productId}?location=${locationId}&editLineId=${line.lineId}`}
          >
            Edit
          </BackLink>
          <button
            type="button"
            onClick={onRemove}
            className="text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            Remove
          </button>
        </div>
      </div>
    </Card>
  );
}

function LineStatusNotice({
  status,
  priorUnitPrice,
  currency,
}: {
  status: LineStatus;
  priorUnitPrice: number;
  currency: string;
}) {
  const message = (() => {
    switch (status.kind) {
      case "removed":
        return "This item is no longer on the menu. Please remove it.";
      case "unavailable":
        return "This item is currently unavailable.";
      case "modifiers-changed":
        return "One of your selected options is no longer available. Please edit this item.";
      case "price-changed":
        return `Price updated from ${formatPrice(priorUnitPrice, currency)} to ${formatPrice(status.unitPrice, currency)}.`;
      default:
        return null;
    }
  })();

  if (!message) {
    return null;
  }

  return (
    <p className="rounded-lg bg-status-warning/10 px-3 py-2 text-xs font-medium text-status-warning">
      {message}
    </p>
  );
}
