"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminLocationMenuProduct } from "@mocha-house/contracts";
import {
  setLocationAvailabilityFromBrowser,
  setLocationPriceFromBrowser,
  useStandardAvailabilityFromBrowser,
  useStandardPriceFromBrowser,
} from "@/lib/api-client";
import { centsToDollarInput, formatPrice, parseDollarInput } from "@/lib/money";
import {
  orderabilityNote,
  usesLocationAvailability,
  usesLocationPrice,
  usingStandardPriceLeavesNoPrice,
} from "@/lib/admin/location-menu";
import { Card } from "@/components/Card";
import { Button } from "./Button";
import { StatusBadge } from "./StatusBadge";
import { ADMIN_FIELD_CLASS } from "./form";

// One product on a location's menu (Milestone 5D-4). Shows what a customer
// here is actually charged and whether they can order it, then offers the
// two adjustments: a location-specific price, and location availability.
// Never says "override" — a location either uses the standard setting or
// sets its own.
export function LocationMenuProductRow({
  locationId,
  menuId,
  product,
}: {
  locationId: string;
  menuId: string;
  product: AdminLocationMenuProduct;
}) {
  const router = useRouter();

  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [editingPrice, setEditingPrice] = useState(false);
  const [priceInput, setPriceInput] = useState(
    centsToDollarInput(product.locationPrice),
  );
  const [priceError, setPriceError] = useState<string | null>(null);
  const [confirmingStandardPrice, setConfirmingStandardPrice] = useState(false);
  const [confirmingUnavailable, setConfirmingUnavailable] = useState(false);

  const hasLocationPrice = usesLocationPrice(product);
  const hasLocationAvailability = usesLocationAvailability(product);

  function reset() {
    setPending(false);
    setEditingPrice(false);
    setConfirmingStandardPrice(false);
    setConfirmingUnavailable(false);
  }

  async function run(
    action: () => Promise<
      | { outcome: "success" }
      | { outcome: "forbidden" }
      | { outcome: "not-found" }
      | { outcome: "invalid"; message: string }
      | { outcome: "error"; message: string }
    >,
    successNote: string,
  ) {
    setPending(true);
    setFeedback(null);
    const result = await action();
    if (result.outcome === "success") {
      reset();
      setFeedback(successNote);
      router.refresh();
      return;
    }
    setPending(false);
    if (result.outcome === "forbidden") {
      setFeedback("You don't have permission to change this.");
    } else if (result.outcome === "not-found") {
      setFeedback("This product is no longer on this menu.");
    } else {
      setFeedback(result.message);
    }
  }

  function saveLocationPrice() {
    const parsed = parseDollarInput(priceInput);
    if (!parsed.ok) {
      setPriceError(parsed.error);
      return;
    }
    if (parsed.cents === null) {
      setPriceError("Enter a price, or choose “Use standard price”.");
      return;
    }
    setPriceError(null);
    void run(
      () =>
        setLocationPriceFromBrowser(
          locationId,
          menuId,
          product.productId,
          parsed.cents as number,
        ),
      "Location price saved.",
    );
  }

  const note = orderabilityNote(product);

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold text-text-primary">
            {product.productName}
          </span>
          {!product.productIsActive ? (
            <StatusBadge label="Inactive product" tone="warning" />
          ) : null}
          {!product.shownOnMenu ? (
            <StatusBadge label="Hidden from menu" tone="warning" />
          ) : null}
        </div>
        <span className="text-sm text-text-secondary">
          {product.categoryName}
        </span>
      </div>

      {/* Price */}
      <div className="flex flex-col gap-2 border-t border-border-default pt-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium text-text-primary">Price</span>
          <span className="text-base text-text-primary">
            {product.resultingPrice === null
              ? "No price"
              : formatPrice(product.resultingPrice, product.currency)}
          </span>
          {hasLocationPrice ? (
            <StatusBadge label="Location price" tone="neutral" />
          ) : (
            <span className="text-xs text-text-muted">Standard price</span>
          )}
        </div>

        {editingPrice ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-text-muted">
              Standard price:{" "}
              {product.standardPrice === null
                ? "none"
                : formatPrice(product.standardPrice, product.currency)}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <input
                inputMode="decimal"
                aria-label={`Location price for ${product.productName}`}
                value={priceInput}
                onChange={(event) => {
                  setPriceInput(event.target.value);
                  setPriceError(null);
                }}
                placeholder="0.00"
                className={`${ADMIN_FIELD_CLASS} min-h-11 w-28`}
              />
              <Button onClick={saveLocationPrice} disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setEditingPrice(false);
                  setPriceError(null);
                  setPriceInput(centsToDollarInput(product.locationPrice));
                }}
                disabled={pending}
              >
                Cancel
              </Button>
            </div>
            {priceError ? (
              <p role="alert" className="text-sm text-status-warning">
                {priceError}
              </p>
            ) : null}
          </div>
        ) : confirmingStandardPrice ? (
          <div className="flex flex-col gap-2 rounded-xl border border-border-default bg-surface-subtle px-3 py-3">
            <p className="text-sm text-text-primary">
              Use no location price? This item won&apos;t have a price at this
              location and can&apos;t be ordered.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() =>
                  void run(
                    () =>
                      useStandardPriceFromBrowser(
                        locationId,
                        menuId,
                        product.productId,
                      ),
                    "Now using the standard price.",
                  )
                }
                disabled={pending}
              >
                {pending ? "Updating…" : "Use standard price"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setConfirmingStandardPrice(false)}
                disabled={pending}
              >
                Keep the location price
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setFeedback(null);
                setPriceInput(centsToDollarInput(product.locationPrice));
                setEditingPrice(true);
              }}
              disabled={pending}
            >
              {hasLocationPrice ? "Change price" : "Set location price"}
            </Button>
            {hasLocationPrice ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setFeedback(null);
                  if (usingStandardPriceLeavesNoPrice(product)) {
                    setConfirmingStandardPrice(true);
                  } else {
                    void run(
                      () =>
                        useStandardPriceFromBrowser(
                          locationId,
                          menuId,
                          product.productId,
                        ),
                      "Now using the standard price.",
                    );
                  }
                }}
                disabled={pending}
              >
                Use standard price
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {/* Availability */}
      <div className="flex flex-col gap-2 border-t border-border-default pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-text-primary">
            Availability
          </span>
          <StatusBadge
            label={product.resultingAvailability ? "Available" : "Unavailable"}
            tone={product.resultingAvailability ? "positive" : "warning"}
          />
          <span className="text-xs text-text-muted">
            {hasLocationAvailability
              ? "Set for this location"
              : "Using standard availability"}
          </span>
        </div>

        {confirmingUnavailable ? (
          <div className="flex flex-col gap-2 rounded-xl border border-border-default bg-surface-subtle px-3 py-3">
            <p className="text-sm text-text-primary">
              Mark this product unavailable here? Customers at this location
              won&apos;t be able to order it.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() =>
                  void run(
                    () =>
                      setLocationAvailabilityFromBrowser(
                        locationId,
                        menuId,
                        product.productId,
                        false,
                      ),
                    "Marked unavailable at this location.",
                  )
                }
                disabled={pending}
              >
                {pending ? "Updating…" : "Mark unavailable"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setConfirmingUnavailable(false)}
                disabled={pending}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {product.resultingAvailability ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setFeedback(null);
                  setConfirmingUnavailable(true);
                }}
                disabled={pending}
              >
                Mark unavailable
              </Button>
            ) : (
              <Button
                variant="secondary"
                onClick={() =>
                  void run(
                    () =>
                      setLocationAvailabilityFromBrowser(
                        locationId,
                        menuId,
                        product.productId,
                        true,
                      ),
                    "Marked available at this location.",
                  )
                }
                disabled={pending}
              >
                Mark available
              </Button>
            )}
            {hasLocationAvailability ? (
              <Button
                variant="secondary"
                onClick={() =>
                  void run(
                    () =>
                      useStandardAvailabilityFromBrowser(
                        locationId,
                        menuId,
                        product.productId,
                      ),
                    "Now using standard availability.",
                  )
                }
                disabled={pending}
              >
                Use standard availability
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {note ? <p className="text-sm text-text-secondary">{note}</p> : null}
      {feedback ? (
        <p role="status" className="text-sm text-text-secondary">
          {feedback}
        </p>
      ) : null}
    </Card>
  );
}
