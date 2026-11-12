import type {
  CancelOrderRequest,
  CloseOrderResponse,
  OrderCancellationReasonCode,
  OrderClosureKind,
  OrderClosureReasonCode,
  OrderRejectionReasonCode,
  OrderStatus,
  RejectOrderRequest,
  StoreOrderClosureSummary,
} from "@mocha-house/contracts";
import {
  ORDER_CANCELLATION_REASON_CODES,
  ORDER_CLOSURE_NOTE_MAX_LENGTH,
  ORDER_CLOSURE_REASON_LABELS,
  ORDER_REJECTION_REASON_CODES,
} from "@mocha-house/contracts";
import { formatPrice } from "@/lib/money";
// Mutating calls to this app's own /api proxy must carry the request
// marker header (rejectUntrustedOrigin); markedFetch adds it, like api-client.
import { markedFetch as fetch } from "@/lib/security/marked-fetch";

// V1 launch fix 1 — rejecting / cancelling an order from Order Details, on
// the existing R1/S5b API (POST /admin/orders/:id/reject | /cancel). The API
// stays the authority: it checks the switch (ORDER_CLOSURE_ENABLED), the
// `orders.cancel` permission at the location, the order's business and
// location, and the status, and it never moves money on a card. This module
// only shapes what staff see and what is sent.

const PROXY = "/api/internal/admin";

// --- which action an order offers ------------------------------------------------

export interface ClosureAction {
  kind: OrderClosureKind;
  // Button / heading wording.
  label: string;
  reasons: readonly OrderClosureReasonCode[];
}

export function closureActionFor(status: OrderStatus): ClosureAction | null {
  switch (status) {
    case "RECEIVED":
      return {
        kind: "REJECTED",
        label: "Reject order",
        reasons: ORDER_REJECTION_REASON_CODES,
      };
    case "ACCEPTED":
    case "PREPARING":
    case "READY":
      return {
        kind: "CANCELLED",
        label: "Cancel order",
        reasons: ORDER_CANCELLATION_REASON_CODES,
      };
    default:
      // COMPLETED, REJECTED, CANCELLED: terminal, nothing to close.
      return null;
  }
}

// --- the form ----------------------------------------------------------------------

export interface ClosureDraft {
  reasonCode: OrderClosureReasonCode | "";
  note: string;
}

export const EMPTY_CLOSURE_DRAFT: ClosureDraft = { reasonCode: "", note: "" };

export interface ClosureDraftErrors {
  reason?: string;
  note?: string;
}

export type ClosureRequest =
  | { kind: "REJECTED"; body: RejectOrderRequest }
  | { kind: "CANCELLED"; body: CancelOrderRequest };

// The one request a confirmation sends — built once, and sent unchanged on
// any retry (the API replays an order already closed the same way).
export function buildClosureRequest(
  action: ClosureAction,
  draft: ClosureDraft,
  context: { locationId: string; status: OrderStatus },
): { ok: true; request: ClosureRequest } | { ok: false; errors: ClosureDraftErrors } {
  const errors: ClosureDraftErrors = {};
  const reason = draft.reasonCode;
  if (!reason || !action.reasons.includes(reason)) {
    errors.reason = "Choose a reason.";
  }
  const note = draft.note.trim();
  if (note.length > ORDER_CLOSURE_NOTE_MAX_LENGTH) {
    errors.note = `Keep the note to ${ORDER_CLOSURE_NOTE_MAX_LENGTH} characters.`;
  } else if (reason === "OTHER" && note.length === 0) {
    errors.note = "Add a short note when the reason is Other.";
  }
  if (errors.reason || errors.note) return { ok: false, errors };
  const withNote = note.length > 0 ? { note } : {};
  if (action.kind === "REJECTED") {
    return {
      ok: true,
      request: {
        kind: "REJECTED",
        body: {
          locationId: context.locationId,
          reasonCode: reason as OrderRejectionReasonCode,
          ...withNote,
        },
      },
    };
  }
  return {
    ok: true,
    request: {
      kind: "CANCELLED",
      body: {
        locationId: context.locationId,
        // The status staff saw: if the order moved since, the API refuses.
        expectedStatus: context.status,
        reasonCode: reason as OrderCancellationReasonCode,
        ...withNote,
      },
    },
  };
}

// --- the call ----------------------------------------------------------------------

export type ClosureResult =
  | { outcome: "success"; data: CloseOrderResponse }
  // 409: the order changed (moved on, already closed differently, …).
  | { outcome: "conflict"; message: string }
  | { outcome: "invalid"; message: string }
  | { outcome: "forbidden" }
  // 404 "not available": rejection / cancellation is switched off.
  | { outcome: "disabled" }
  // 404 otherwise: not an order of this location / business.
  | { outcome: "not-found" }
  // 503: the order was busy; nothing changed.
  | { outcome: "busy"; message: string }
  // No definite answer (network, other server error, rate limit, unreadable
  // reply): it MAY have been applied. Only the same request may be retried.
  | { outcome: "uncertain"; message: string };

async function messageOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string") return body.message;
    if (Array.isArray(body.message) && typeof body.message[0] === "string") {
      return body.message[0];
    }
    return null;
  } catch {
    return null;
  }
}

function redirectToInternalSignIn(): void {
  if (typeof window !== "undefined") {
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/internal/sign-in";
  }
}

export async function closeStoreOrderFromBrowser(
  orderId: string,
  request: ClosureRequest,
): Promise<ClosureResult> {
  const action = request.kind === "REJECTED" ? "reject" : "cancel";
  let response: Response;
  try {
    response = await fetch(
      `${PROXY}/orders/${encodeURIComponent(orderId)}/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      },
    );
  } catch {
    return {
      outcome: "uncertain",
      message: "We couldn't reach the server, so we don't know yet whether the order was closed.",
    };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "uncertain",
      message: "Your session has expired. Sign in again, then check the order.",
    };
  }
  if (response.status === 403) return { outcome: "forbidden" };
  if (response.status === 404) {
    const message = (await messageOf(response)) ?? "";
    return /not available/i.test(message)
      ? { outcome: "disabled" }
      : { outcome: "not-found" };
  }
  if (response.status === 409) {
    return {
      outcome: "conflict",
      message:
        (await messageOf(response)) ?? "This order changed. Check its current status.",
    };
  }
  if (response.status === 400) {
    return {
      outcome: "invalid",
      message: (await messageOf(response)) ?? "Please check the details.",
    };
  }
  if (response.status === 503) {
    return {
      outcome: "busy",
      message:
        (await messageOf(response)) ??
        "This order is busy right now. Nothing was changed; try again in a moment.",
    };
  }
  if (!response.ok) {
    return {
      outcome: "uncertain",
      message:
        response.status === 429
          ? "Too many attempts in a short time. Wait a moment, then try again."
          : "The server had a problem, so we don't know yet whether the order was closed.",
    };
  }
  try {
    const data = (await response.json()) as unknown;
    if (
      typeof data !== "object" ||
      data === null ||
      typeof (data as { status?: unknown }).status !== "string" ||
      typeof (data as { closure?: unknown }).closure !== "object"
    ) {
      throw new Error("unexpected reply");
    }
    return { outcome: "success", data: data as CloseOrderResponse };
  } catch {
    return {
      outcome: "uncertain",
      message: "The reply couldn't be read, so we don't know yet whether the order was closed.",
    };
  }
}

// --- the steps after a result ------------------------------------------------------

export type ClosureFlow =
  | { step: "closed-form"; notice: string | null }
  // `openedFor`: the status the form was opened for. If the order moves on
  // while it is open (e.g. someone accepts it), the form is withdrawn.
  | { step: "form"; notice: string | null; openedFor?: OrderStatus }
  | { step: "submitting"; request: ClosureRequest }
  // No definite answer: only "try again" (the same request) is offered.
  | { step: "retry"; request: ClosureRequest; message: string }
  | { step: "done"; replayed: boolean };

export interface ClosureFlowAfter {
  flow: ClosureFlow;
  // Reload the order (its status, closure and refunds).
  reload: boolean;
}

export function closureFlowAfter(
  request: ClosureRequest,
  result: ClosureResult,
): ClosureFlowAfter {
  switch (result.outcome) {
    case "success":
      return { flow: { step: "done", replayed: !result.data.closed }, reload: true };
    case "uncertain":
      return { flow: { step: "retry", request, message: result.message }, reload: false };
    case "busy":
      // Nothing changed: the same request may simply be sent again.
      return { flow: { step: "retry", request, message: result.message }, reload: false };
    case "conflict":
      return {
        flow: {
          step: "closed-form",
          notice: `${result.message} The order has been refreshed — check its current status.`,
        },
        reload: true,
      };
    case "invalid":
      return { flow: { step: "form", notice: result.message }, reload: false };
    case "forbidden":
      return {
        flow: {
          step: "closed-form",
          notice: "You don't have permission to reject or cancel orders at this location.",
        },
        reload: false,
      };
    case "disabled":
      return {
        flow: {
          step: "closed-form",
          notice: "Rejecting and cancelling orders isn't switched on for this business yet.",
        },
        reload: false,
      };
    case "not-found":
      return {
        flow: {
          step: "closed-form",
          notice: "This order wasn't found at this location.",
        },
        reload: true,
      };
  }
}

// --- what a closed order shows -------------------------------------------------------

export interface ClosureLine {
  label: string;
  value: string;
  emphasis?: boolean;
}

export function closureSummaryLines(
  closure: StoreOrderClosureSummary,
  currency: string,
  pointsLabel: string,
): ClosureLine[] {
  const lines: ClosureLine[] = [
    { label: "Reason", value: closure.reasonLabel || reasonLabel(closure.reasonCode) },
    {
      label: closure.kind === "REJECTED" ? "Rejected" : "Cancelled",
      value: new Date(closure.closedAt).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    },
  ];
  if (closure.kind === "CANCELLED") {
    lines.push({ label: "Was", value: statusWord(closure.fromStatus) });
  }
  if (closure.giftCardRestoredMinorUnits > 0) {
    lines.push({
      label: "Gift card restored",
      value: formatPrice(closure.giftCardRestoredMinorUnits, currency),
    });
  }
  if (closure.loyaltyShortfallBeans > 0) {
    lines.push({
      label: `${pointsLabel} not recovered`,
      value: String(closure.loyaltyShortfallBeans),
    });
  }
  lines.push(
    closure.refundDueMinorUnits > 0
      ? {
          label: "Card amount owed at closing",
          value: formatPrice(closure.refundDueMinorUnits, currency),
          emphasis: true,
        }
      : { label: "Card amount owed at closing", value: "None (nothing was charged to a card)" },
  );
  return lines;
}

function reasonLabel(code: string): string {
  return code in ORDER_CLOSURE_REASON_LABELS
    ? ORDER_CLOSURE_REASON_LABELS[code as OrderClosureReasonCode]
    : code;
}

function statusWord(status: OrderStatus): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

// The plain explanation shown before confirming.
export function closureExplanation(kind: OrderClosureKind): string[] {
  return [
    kind === "REJECTED"
      ? "The order is turned away and leaves the queue. This can't be undone."
      : "The order is called off and leaves the queue. This can't be undone.",
    "Any gift card, rewards and promotion the order used are given back automatically.",
    "This does NOT refund the customer's card. If the order was paid by card, the amount is recorded as a card refund owed, for someone who can refund to process separately in Card refunds.",
  ];
}

export function closureOutcomeMessage(
  kind: OrderClosureKind,
  replayed: boolean,
): string {
  const done = kind === "REJECTED" ? "rejected" : "cancelled";
  return replayed
    ? `This order had already been ${done}. Nothing was changed again.`
    : `Order ${done}.`;
}
