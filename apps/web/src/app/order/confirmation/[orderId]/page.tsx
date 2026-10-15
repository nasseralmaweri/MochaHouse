"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { OrderStatusResponse } from "@mocha-house/contracts";
import {
  fetchGuestShareToken,
  pollOrderStatusFromBrowser,
  startGuestSession,
} from "@/lib/api-client";
import {
  buildShareUrl,
  extractLinkCredential,
  hasCredentialParams,
} from "@/lib/guest-link";
import { formatPrice } from "@/lib/money";
import {
  PollingController,
  browserPollingEnv,
} from "@/lib/polling/polling-controller";
import { usePollingController } from "@/lib/polling/use-polling";
import {
  TRACKING_POLL,
  TRACKING_STATUS_LABEL,
  describeTrackingConnection,
  isTrackingFinal,
  statusChangeAnnouncement,
  statusHeadline,
  trackingDocumentTitle,
} from "@/lib/order-tracking";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";

const TONE_CLASS = {
  ok: "text-status-success",
  warning: "text-status-warning",
  danger: "text-status-error",
} as const;

// How long a spoken status change stays in the live region before it is
// cleared, so the next one is read even if the wording repeats.
const ANNOUNCEMENT_CLEAR_MS = 8_000;

function timeLabel(ms: number | null): string {
  if (ms === null) return "";
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

// The order id in the URL plus the HttpOnly guest-session cookie are the only
// sources of truth here — this page never reads the cart or any client-side
// session state, so a reload, a bookmark, or navigating away and back all
// resolve the same way: refetch from the backend and render whatever it says
// right now. The tracking URL itself carries no credential (R1 / S3c).
export default function OrderConfirmationPage() {
  const params = useParams<{ orderId: string }>();
  return <GuestSessionGate key={params.orderId} orderId={params.orderId} />;
}

type GateState = "checking" | "ready" | "retry";

// Converts a legacy ?token= link or a shared #t= fragment link into the
// cookie session. The credential is removed from the address bar and history
// IMMEDIATELY (before any network call, and whatever happens to the request),
// and held only in memory for the exchange and any "Try again".
function GuestSessionGate({ orderId }: { orderId: string }) {
  const [state, setState] = useState<GateState>("checking");
  const [attempt, setAttempt] = useState(0);
  const credentialRef = useRef<string | null>(null);

  useEffect(() => {
    const { search, hash, pathname } = window.location;
    const fromUrl = extractLinkCredential(search, hash);
    if (fromUrl) credentialRef.current = fromUrl;
    if (hasCredentialParams(search, hash)) {
      window.history.replaceState(window.history.state, "", pathname);
    }
    const credential = credentialRef.current;
    let cancelled = false;
    (async () => {
      const result = credential
        ? await startGuestSession(orderId, credential)
        : ({ outcome: "none" } as const);
      if (cancelled) return;
      if (result.outcome === "error") {
        setState("retry");
        return;
      }
      credentialRef.current = null;
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId, attempt]);

  if (state === "checking") {
    return (
      <main
        role="status"
        aria-live="polite"
        className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8"
      >
        <PageHeader title="Opening your order…" />
      </main>
    );
  }
  if (state === "retry") {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader
          title="Couldn't open your order"
          subtitle="We couldn't open your order just now. Please wait a moment, check your connection and try again."
        />
        <button
          type="button"
          onClick={() => {
            setState("checking");
            setAttempt((n) => n + 1);
          }}
          className="self-start text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Try again
        </button>
      </main>
    );
  }
  return <OrderTracking key={orderId} orderId={orderId} />;
}

function OrderTracking({ orderId }: { orderId: string }) {
  const previousStatus = useRef<OrderStatusResponse["status"] | null>(null);
  // Alternates a trailing no-break space so two identical announcements in a
  // row still change the live region and are both spoken.
  const announceFlip = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const [shareState, setShareState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  // Explicit user action: ask the server for this browser's credential and put
  // it in a URL FRAGMENT, which no server or Referer ever sees.
  async function copyTrackingLink() {
    const token = await fetchGuestShareToken(orderId);
    if (!token) {
      setShareState("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(
        buildShareUrl(window.location.origin, orderId, token),
      );
      setShareState("copied");
    } catch {
      setShareState("failed");
    }
  }

  const { controller, snapshot } = usePollingController<OrderStatusResponse>(
    () =>
      new PollingController<OrderStatusResponse>({
        env: browserPollingEnv(),
        fetch: async () => {
          const result = await pollOrderStatusFromBrowser(orderId);
          if (result.outcome === "success") {
            return { outcome: "success", data: result.status };
          }
          return { outcome: result.outcome };
        },
        // A completed order cannot change again: stop polling.
        isFinal: isTrackingFinal,
        onData: (next) => {
          const message = statusChangeAnnouncement(
            previousStatus.current,
            next.status,
          );
          previousStatus.current = next.status;
          if (message) {
            announceFlip.current = !announceFlip.current;
            setAnnouncement(
              message + (announceFlip.current ? String.fromCharCode(160) : ""),
            );
          }
        },
        ...TRACKING_POLL,
      }),
  );

  const status = snapshot.data;
  const notice = describeTrackingConnection(snapshot.connection);

  // The tab title carries the status, so a customer on another tab can see
  // "Ready" at a glance. Order number and status only.
  useEffect(() => {
    if (!status) return;
    const previous = document.title;
    document.title = trackingDocumentTitle(status.orderNumber, status.status);
    return () => {
      document.title = previous;
    };
  }, [status]);

  useEffect(() => {
    if (!announcement) return;
    const handle = window.setTimeout(
      () => setAnnouncement(""),
      ANNOUNCEMENT_CLEAR_MS,
    );
    return () => window.clearTimeout(handle);
  }, [announcement]);

  if (snapshot.connection === "not-found" || snapshot.connection === "forbidden") {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader
          title="This order can't be opened here"
          subtitle="We can't open this order on this device. Open it on the device where you placed the order and use Copy tracking link there, or start a new order."
        />
        <BackLink href="/order/location">Start a new order</BackLink>
      </main>
    );
  }

  if (!status && snapshot.connection === "failed") {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader
          title="Couldn't load your order"
          subtitle="Please check your connection. We'll keep trying, or you can try now."
        />
        <button
          type="button"
          onClick={() => controller.refreshNow()}
          className="self-start text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Try again
        </button>
        <BackLink href="/order/location">Start a new order</BackLink>
      </main>
    );
  }

  if (!status) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title="Loading your order…" />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Order confirmed"
        subtitle={`Order #${status.orderNumber} · ${status.locationName}`}
      />

      <Card className="flex flex-col gap-2">
        <ul className="flex flex-col gap-2">
          {status.lines.map((line, index) => (
            <li key={index} className="flex items-start justify-between gap-4 text-sm">
              <span className="text-text-primary">
                {line.quantity}× {line.productName}
                {line.selections.length > 0 ? (
                  <span className="block text-xs text-text-muted">
                    {line.selections.map((s) => s.optionNames.join(", ")).join(" · ")}
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
          {status.orderPromotion ||
          status.loyaltyReward ||
          status.orderGiftCard ? (
            <div className="flex items-center justify-between text-sm text-text-secondary">
              <span>Subtotal</span>
              <span>{formatPrice(status.subtotal, status.currency)}</span>
            </div>
          ) : null}
          {status.orderPromotion ? (
            <div className="flex items-center justify-between text-sm text-status-success">
              <span>
                {status.orderPromotion.kind === "COUPON" ? "Coupon" : "Promotion"}
                {" · "}
                {status.orderPromotion.name}
              </span>
              <span>
                −{formatPrice(status.promotionDiscount, status.currency)}
              </span>
            </div>
          ) : null}
          {status.loyaltyReward ? (
            <div className="flex items-center justify-between text-sm text-status-success">
              <span>Mocha Beans Reward · {status.loyaltyReward.rewardName}</span>
              <span>−{formatPrice(status.rewardDiscount, status.currency)}</span>
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <span
              className={`text-sm ${
                status.orderGiftCard
                  ? "text-text-secondary"
                  : "font-semibold text-text-primary"
              }`}
            >
              {status.orderGiftCard ? "Order total" : "Total"}
            </span>
            <span
              className={
                status.orderGiftCard
                  ? "text-sm text-text-secondary"
                  : "text-lg font-semibold text-text-primary"
              }
            >
              {formatPrice(status.total, status.currency)}
            </span>
          </div>
          {status.orderGiftCard ? (
            <>
              <div className="flex items-center justify-between text-sm text-status-success">
                <span>Gift Card •••• {status.orderGiftCard.last4}</span>
                <span>
                  −
                  {formatPrice(
                    status.orderGiftCard.amountMinorUnits,
                    status.currency,
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-text-primary">
                  Paid by card
                </span>
                <span className="text-lg font-semibold text-text-primary">
                  {formatPrice(
                    status.externalPaymentMinorUnits,
                    status.currency,
                  )}
                </span>
              </div>
            </>
          ) : null}
          {status.loyaltyReward ? (
            <p className="text-xs text-text-muted">
              {status.loyaltyReward.beanCost} Mocha Beans used
            </p>
          ) : null}
          {status.loyaltyBonus && status.loyaltyBonus.totalBonusBeans > 0 ? (
            <p className="text-xs text-status-success">
              +{status.loyaltyBonus.totalBonusBeans} bonus Mocha Beans earned
            </p>
          ) : null}
        </div>
      </Card>

      <Card tone="subtle" className="flex flex-col gap-3 text-sm text-text-secondary">
        <span>Thanks, {status.guestName}!</span>
        <div className="flex flex-col gap-1">
          <span className="text-base font-semibold text-text-primary">
            {statusHeadline(status.status)}
          </span>
          <span>Status: {TRACKING_STATUS_LABEL[status.status]}</span>
        </div>

        {/* Spoken announcement of a status change; visually hidden. */}
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-default pt-2">
          {/* Only the state text is a live region, so it is announced when the
              state changes, not on every refresh. */}
          <span
            role="status"
            aria-live="polite"
            className={`text-xs font-medium ${TONE_CLASS[notice.tone]}`}
          >
            {notice.label}
          </span>
          <span className="flex items-center gap-3 text-xs">
            {snapshot.lastSuccessAt !== null ? (
              <span className="text-text-muted">
                Updated {timeLabel(snapshot.lastSuccessAt)}
              </span>
            ) : null}
            {snapshot.connection !== "complete" ? (
              <button
                type="button"
                onClick={() => controller.refreshNow()}
                disabled={snapshot.refreshing}
                className="font-medium text-text-primary underline underline-offset-2 disabled:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {snapshot.refreshing ? "Refreshing…" : "Refresh status"}
              </button>
            ) : null}
          </span>
        </div>
      </Card>

      <div className="flex flex-col gap-1 text-xs text-text-muted">
        <button
          type="button"
          onClick={copyTrackingLink}
          className="self-start font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Copy tracking link
        </button>
        <span role="status" aria-live="polite">
          {shareState === "copied"
            ? "Link copied. Anyone with it can see this order's status."
            : shareState === "failed"
              ? "Couldn't copy the link."
              : "Open this link on another device to follow the order there."}
        </span>
      </div>

      <BackLink href="/order/location">Start a new order</BackLink>
    </main>
  );
}
