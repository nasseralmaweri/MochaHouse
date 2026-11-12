import type {
  CreateOrderRefundRequest,
  OrderRefundActionResponse,
  OrderRefundBalances,
  OrderRefundObligationListItem,
  OrderRefundObligationsResponse,
  OrderRefundObligationView,
  OrderRefundReasonCode,
  OrderRefundsResponse,
  OrderRefundView,
  OrderStatus,
} from "@mocha-house/contracts";
import {
  ORDER_REFUND_NOTE_MAX_LENGTH,
  ORDER_REFUND_REASON_CODES,
} from "@mocha-house/contracts";
import { formatPrice } from "@/lib/money";

// ESP-04 M5d — the staff refund interface's logic, kept out of the React
// components so it can be tested on its own. The API (M5b/M5c) stays the only
// authority: every amount shown comes from its refund balances, every refund
// is checked again there, and this module only shapes what staff see and
// what is sent.

const PROXY = "/api/internal/admin";

function redirectToInternalSignIn(): void {
  if (typeof window !== "undefined") {
    // A full navigation, so the server /admin boundary re-runs.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/internal/sign-in";
  }
}

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

// --- reads ---------------------------------------------------------------------

export type RefundReadResult<T> =
  | { outcome: "success"; data: T }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "error" };

async function read<T>(
  url: string,
  isValid: (body: unknown) => boolean,
): Promise<RefundReadResult<T>> {
  let response: Response;
  try {
    // no-store: refund figures must never be served from a cache.
    response = await fetch(url, { cache: "no-store" });
  } catch {
    return { outcome: "error" };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error" };
  }
  if (response.status === 403) return { outcome: "forbidden" };
  if (response.status === 404) return { outcome: "not-found" };
  if (!response.ok) return { outcome: "error" };
  try {
    const body: unknown = await response.json();
    return isValid(body)
      ? { outcome: "success", data: body as T }
      : { outcome: "error" };
  } catch {
    return { outcome: "error" };
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

export function getOrderRefundsFromBrowser(
  orderId: string,
  locationId: string,
): Promise<RefundReadResult<OrderRefundsResponse>> {
  return read<OrderRefundsResponse>(
    `${PROXY}/orders/${encodeURIComponent(orderId)}/refunds?locationId=${encodeURIComponent(locationId)}`,
    (b) => isObject(b) && Array.isArray(b.refunds),
  );
}

export function getRefundObligationsFromBrowser(
  locationId: string,
): Promise<RefundReadResult<OrderRefundObligationsResponse>> {
  return read<OrderRefundObligationsResponse>(
    `${PROXY}/orders/refund-obligations?locationId=${encodeURIComponent(locationId)}`,
    (b) => isObject(b) && Array.isArray(b.obligations),
  );
}

// --- actions ---------------------------------------------------------------------

export type RefundActionResult =
  | { outcome: "success"; data: OrderRefundActionResponse }
  // Refused on the current figures (409): changed since, already reviewed,
  // waiting for an answer, … Nothing was done.
  | { outcome: "conflict"; message: string }
  // The request itself was not acceptable (400). Nothing was done.
  | { outcome: "invalid"; message: string }
  | { outcome: "forbidden" }
  // 404: refunds are switched off for this business, or the order / refund
  // is not one this location has.
  | { outcome: "unavailable" }
  // No definite answer (the network, a server error, rate limiting, an
  // unreadable reply): the request MAY have been made. Only the SAME request
  // may be sent again — it returns the refund it made, never a second one.
  | { outcome: "uncertain"; message: string };

async function act(path: string, body: unknown): Promise<RefundActionResult> {
  let response: Response;
  try {
    response = await fetch(`${PROXY}/orders/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      outcome: "uncertain",
      message: "We couldn't reach the server, so we don't know yet whether this went through.",
    };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "uncertain",
      message: "Your session has expired. Sign in again, then check the result.",
    };
  }
  if (response.status === 403) return { outcome: "forbidden" };
  if (response.status === 404) return { outcome: "unavailable" };
  if (response.status === 409) {
    return {
      outcome: "conflict",
      message:
        (await messageOf(response)) ??
        "The refunds on this order changed. Check the latest figures.",
    };
  }
  if (response.status === 400) {
    return {
      outcome: "invalid",
      message: (await messageOf(response)) ?? "Please check the details.",
    };
  }
  if (response.status === 429) {
    return {
      outcome: "uncertain",
      message: "Too many attempts in a short time. Wait a moment, then check again.",
    };
  }
  if (!response.ok) {
    return {
      outcome: "uncertain",
      message: "The server had a problem, so we don't know yet whether this went through.",
    };
  }
  try {
    const data = (await response.json()) as unknown;
    if (!isObject(data) || !isObject(data.refund) || !isObject(data.balances)) {
      throw new Error("unexpected reply");
    }
    return { outcome: "success", data: data as unknown as OrderRefundActionResponse };
  } catch {
    return {
      outcome: "uncertain",
      message: "The reply couldn't be read, so we don't know yet whether this went through.",
    };
  }
}

export function requestOrderRefundFromBrowser(
  orderId: string,
  request: CreateOrderRefundRequest,
): Promise<RefundActionResult> {
  return act(`${encodeURIComponent(orderId)}/refunds`, request);
}

export function recheckOrderRefundFromBrowser(
  orderId: string,
  refundId: string,
  locationId: string,
): Promise<RefundActionResult> {
  return act(
    `${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}/recheck`,
    { locationId },
  );
}

export function reviewOrderRefundFromBrowser(
  orderId: string,
  refundId: string,
  locationId: string,
  note: string,
): Promise<RefundActionResult> {
  return act(
    `${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}/review`,
    { locationId, note },
  );
}

// --- plain-language status -------------------------------------------------------

export type RefundTone = "neutral" | "positive" | "warning";

export interface RefundStatusView {
  label: string;
  tone: RefundTone;
  // One short sentence of what it means, or null.
  detail: string | null;
}

export function refundStatusView(refund: OrderRefundView): RefundStatusView {
  const dashboard = refund.origin === "EXTERNAL";
  switch (refund.status) {
    case "REQUESTED":
    case "UNKNOWN":
      return {
        label: "Outcome being verified",
        tone: "warning",
        detail: "Stripe's answer hasn't been confirmed yet. The amount stays set aside until it is.",
      };
    case "PENDING":
      return {
        label: dashboard ? "Refund pending (Stripe Dashboard)" : "Refund pending",
        tone: "neutral",
        detail: "Stripe accepted the refund and is still processing it.",
      };
    case "SUCCEEDED":
      return dashboard
        ? {
            label: "Refunded through Stripe Dashboard",
            tone: "positive",
            detail: "Made outside CENTERIVO, in the business's Stripe Dashboard.",
          }
        : { label: "Refund successful", tone: "positive", detail: null };
    case "FAILED":
      return {
        label: "Refund failed",
        tone: "warning",
        detail: "No money was returned to the card.",
      };
    case "CANCELED":
      return {
        label: "Refund failed",
        tone: "warning",
        detail: "The refund was canceled at Stripe. No money was returned.",
      };
    case "NOT_CREATED":
      return {
        label: "Not sent",
        tone: "neutral",
        detail: "Stripe never made this refund. No money moved.",
      };
    case "FAILED_AFTER_SUCCESS":
      return refund.lateFailureReviewedAt
        ? {
            label: "Refund returned (reviewed)",
            tone: "neutral",
            detail: "The money came back from the card after the refund. It has been reviewed.",
          }
        : {
            label: "Refund returned — needs review",
            tone: "warning",
            detail: "The money came back from the card after the refund. Review it before refunding again.",
          };
    default:
      return { label: "Unknown status", tone: "warning", detail: null };
  }
}

// A refund staff may ask Stripe about again (M5b's recheck): one of ours
// still waiting for an answer, or pending.
export function canRecheck(refund: OrderRefundView): boolean {
  return (
    refund.origin === "CENTERIVO" &&
    (refund.status === "REQUESTED" ||
      refund.status === "UNKNOWN" ||
      refund.status === "PENDING")
  );
}

export function needsLateFailureReview(refund: OrderRefundView): boolean {
  return (
    refund.status === "FAILED_AFTER_SUCCESS" && refund.lateFailureReviewedAt === null
  );
}

export function obligationStatusLabel(o: OrderRefundObligationView): string {
  if (o.fullyRefunded && o.outstandingMinorUnits === 0) return "Refunded";
  if (o.inProgressMinorUnits > 0) return "Refund in progress";
  if (o.recordedStatus === "FAILED") return "Refund failed";
  if (o.refundedMinorUnits > 0) return "Partly refunded";
  return "Refund owed";
}

// --- what this staff member may do here -------------------------------------------

export interface RefundAccess {
  // The refund action may be offered.
  canIssue: boolean;
  // Why not, in plain language (null when it may, or when the person may
  // not refund at all — they simply see no action).
  reason: string | null;
  // The most a new refund may be for (server figures only).
  maxMinorUnits: number;
}

export function refundAccess(
  data: OrderRefundsResponse,
  canRefund: boolean,
): RefundAccess {
  const none = (reason: string | null): RefundAccess => ({
    canIssue: false,
    reason,
    maxMinorUnits: 0,
  });
  if (!canRefund) return none(null);
  if (!data.refundsEnabled) {
    return none("Card refunds aren't switched on for this business yet.");
  }
  const balances = data.balances;
  if (!balances) {
    return none("This order has no card payment that can be refunded here.");
  }
  const closed = data.orderStatus === "REJECTED" || data.orderStatus === "CANCELLED";
  if (closed && !data.obligation) {
    return none("Nothing is owed on this order's card payment.");
  }
  if (!closed && data.orderStatus !== "COMPLETED") {
    return none("Only a completed order can be refunded. An order in progress is cancelled instead.");
  }
  if (balances.unresolved) {
    return none("A refund is still being verified. Check it before starting another.");
  }
  if (balances.lateFailureNeedsReview) {
    return none("A refund came back from the card. Review it before refunding again.");
  }
  // M5c reconciliation found something it could not match: no new refund
  // until support has resolved it.
  if (data.paymentNeedsAttention || (data.attentionRefundIds ?? []).length > 0) {
    return none(
      "This order's refund records need attention from support. New refunds are paused until that's resolved.",
    );
  }
  // Amounts are shown and typed in cents; other currencies are not offered.
  if (minorUnitDigits(data.currency) !== 2) {
    return none("Refunds in this currency can't be made from this page.");
  }
  const max = data.obligation
    ? Math.min(balances.refundableMinorUnits, data.obligation.outstandingMinorUnits)
    : balances.refundableMinorUnits;
  if (max <= 0) return none("There's nothing left to refund on this card payment.");
  return { canIssue: true, reason: null, maxMinorUnits: max };
}

// --- the refund form ----------------------------------------------------------------

export interface RefundDraft {
  mode: "full" | "partial";
  amountInput: string;
  reasonCode: OrderRefundReasonCode | "";
  note: string;
}

export const EMPTY_DRAFT: RefundDraft = {
  mode: "full",
  amountInput: "",
  reasonCode: "",
  note: "",
};

export interface DraftErrors {
  amount?: string;
  reason?: string;
  note?: string;
}

export type ValidDraft = {
  amountMinorUnits: number;
  reasonCode: OrderRefundReasonCode;
  note: string | undefined;
};

// The number of minor-unit digits of a currency (2 for USD, 0 for JPY).
function currencySymbol(currency: string): string | null {
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency })
        .formatToParts(0)
        .find((p) => p.type === "currency")?.value ?? null
    );
  } catch {
    return null;
  }
}

export function minorUnitDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

// A typed amount, as integer minor units — never through floating point
// (the whole and fractional parts are read as integers). Null when it is
// not a plain positive amount with at most the currency's decimals.
export function parseRefundAmount(raw: string, currency: string): number | null {
  const digits = minorUnitDigits(currency);
  let cleaned = raw.trim();
  // Only the currency's own symbol may lead (e.g. "$" for USD).
  const symbol = currencySymbol(currency);
  if (symbol && cleaned.startsWith(symbol)) cleaned = cleaned.slice(symbol.length).trim();
  // A comma is accepted ONLY as proper thousands grouping ("1,005.50"):
  // "4,50" (a decimal comma) is refused rather than read as 450.
  const fractionPart = digits === 0 ? "" : `(\\.\\d{1,${digits}})?`;
  const plain = new RegExp(`^\\d+${fractionPart}$`);
  const grouped = new RegExp(`^\\d{1,3}(,\\d{3})+${fractionPart}$`);
  if (!plain.test(cleaned) && !grouped.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.replace(/,/g, "").split(".");
  if (whole.length > 9) return null;
  const minor =
    Number(whole) * 10 ** digits + (digits === 0 ? 0 : Number(fraction.padEnd(digits, "0")));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

export function validateDraft(
  draft: RefundDraft,
  maxMinorUnits: number,
  currency: string,
): { ok: true; value: ValidDraft } | { ok: false; errors: DraftErrors } {
  const errors: DraftErrors = {};
  let amount = maxMinorUnits;
  if (draft.mode === "partial") {
    const parsed = parseRefundAmount(draft.amountInput, currency);
    if (parsed === null) {
      errors.amount = "Enter an amount like 4.50.";
    } else if (parsed > maxMinorUnits) {
      errors.amount = `At most ${formatPrice(maxMinorUnits, currency)} can be refunded.`;
    } else {
      amount = parsed;
    }
  }
  if (!draft.reasonCode || !ORDER_REFUND_REASON_CODES.includes(draft.reasonCode)) {
    errors.reason = "Choose a reason.";
  }
  const note = draft.note.trim();
  if (note.length > ORDER_REFUND_NOTE_MAX_LENGTH) {
    errors.note = `Keep the note to ${ORDER_REFUND_NOTE_MAX_LENGTH} characters.`;
  } else if (draft.reasonCode === "OTHER" && note.length === 0) {
    errors.note = "Add a short note when the reason is Other.";
  }
  if (errors.amount || errors.reason || errors.note) return { ok: false, errors };
  return {
    ok: true,
    value: {
      amountMinorUnits: amount,
      reasonCode: draft.reasonCode as OrderRefundReasonCode,
      note: note.length > 0 ? note : undefined,
    },
  };
}

// What already counts against the payment, as the server last reported it:
// a refund is refused (409) if this changed, so two people — or a page left
// open — never refund twice by accident.
export function expectedReservedOf(balances: OrderRefundBalances): number {
  return balances.refundedMinorUnits + balances.inProgressMinorUnits;
}

// The one request a submission makes. Its requestId is created ONCE, when
// the staff member reaches the review step, and the identical request is
// what any retry sends.
export function buildRefundRequest(
  value: ValidDraft,
  context: {
    locationId: string;
    currency: string;
    balances: OrderRefundBalances;
    requestId: string;
  },
): CreateOrderRefundRequest {
  return {
    locationId: context.locationId,
    requestId: context.requestId,
    amountMinorUnits: value.amountMinorUnits,
    currency: context.currency.toUpperCase(),
    reasonCode: value.reasonCode,
    ...(value.note ? { note: value.note } : {}),
    expectedReservedMinorUnits: expectedReservedOf(context.balances),
  };
}

// --- the submission's steps ---------------------------------------------------------

export type RefundFlow =
  | { step: "closed"; notice: string | null }
  | { step: "editing"; notice: string | null }
  | { step: "review"; request: CreateOrderRefundRequest }
  | { step: "submitting"; request: CreateOrderRefundRequest }
  // No definite answer: only "check the result" (the same request) is offered.
  | { step: "uncertain"; request: CreateOrderRefundRequest; message: string }
  | { step: "done"; refund: OrderRefundView; replayed: boolean };

export interface FlowAfter {
  flow: RefundFlow;
  // Reload the server's figures (always after a definite answer).
  reload: boolean;
  // The request is settled: forget the saved pending request.
  settled: boolean;
}

export function flowAfter(
  request: CreateOrderRefundRequest,
  result: RefundActionResult,
  // The request was a retry of one whose answer was unknown: a refusal now
  // (403 / 404 / 400 — checked before the server looks the request up)
  // proves nothing about the earlier send, so it stays pending.
  retryOfUnknown = false,
): FlowAfter {
  if (
    retryOfUnknown &&
    (result.outcome === "forbidden" ||
      result.outcome === "unavailable" ||
      result.outcome === "invalid")
  ) {
    return {
      flow: {
        step: "uncertain",
        request,
        message:
          result.outcome === "forbidden"
            ? "You no longer have permission to check this refund here. Its outcome is still unknown — see the refund history below or contact support."
            : result.outcome === "unavailable"
              ? "Refunds aren't available right now, so this refund's outcome is still unknown. See the refund history below or contact support."
              : `${result.message} This refund's outcome is still unknown — see the refund history below or contact support.`,
      },
      reload: true,
      settled: false,
    };
  }
  switch (result.outcome) {
    case "success":
      return {
        flow: { step: "done", refund: result.data.refund, replayed: result.data.replayed },
        reload: true,
        settled: true,
      };
    case "uncertain":
      return {
        flow: { step: "uncertain", request, message: result.message },
        reload: false,
        settled: false,
      };
    case "conflict":
      // Nothing was refunded on these figures. Fresh figures, and a fresh
      // review (a new submission) before anything else is sent.
      return {
        flow: {
          step: "editing",
          notice: `${result.message} The latest figures are shown below — review the refund again before submitting.`,
        },
        reload: true,
        settled: true,
      };
    case "invalid":
      return {
        flow: { step: "editing", notice: result.message },
        reload: false,
        settled: true,
      };
    case "forbidden":
      return {
        flow: {
          step: "closed",
          notice: "You don't have permission to refund orders at this location.",
        },
        reload: true,
        settled: true,
      };
    case "unavailable":
      return {
        flow: {
          step: "closed",
          notice: "Refunds aren't available for this order right now.",
        },
        reload: true,
        settled: true,
      };
  }
}

export function refundOutcomeMessage(refund: OrderRefundView, replayed: boolean): string {
  const amount = formatPrice(refund.amountMinorUnits, refund.currency);
  const already = replayed ? " (this refund had already been submitted)" : "";
  switch (refund.status) {
    case "SUCCEEDED":
      return `Refund of ${amount} successful${already}.`;
    case "PENDING":
      return `Refund of ${amount} is pending at Stripe${already}.`;
    case "REQUESTED":
    case "UNKNOWN":
      return `Refund of ${amount} sent${already}. Its outcome is being verified — check it shortly.`;
    case "NOT_CREATED":
      return `The refund of ${amount} was not made${already}. No money moved.`;
    default:
      return `The refund of ${amount} failed${already}. No money was returned to the card.`;
  }
}

// --- a submission left unanswered, kept across a reload -------------------------------
// If the page is closed or reloaded while a refund's answer is unknown, the
// same request is restored so staff check its result instead of starting a
// new refund. Browser storage is a convenience only: the server's
// expected-balance check and its "waiting for an answer" block still stop a
// second refund if this is lost.

const PENDING_PREFIX = "centerivo:pending-refund:";

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Keyed by the signed-in staff member AND the order: another person on the
// same browser never inherits someone else's pending refund.
function pendingKey(userId: string, orderId: string): string {
  return `${PENDING_PREFIX}${userId}:${orderId}`;
}

export function savePendingRefund(
  store: KeyValueStore | null,
  userId: string,
  orderId: string,
  request: CreateOrderRefundRequest,
): void {
  try {
    store?.setItem(pendingKey(userId, orderId), JSON.stringify(request));
  } catch {
    // Storage unavailable: the server-side guards still apply.
  }
}

export function clearPendingRefund(
  store: KeyValueStore | null,
  userId: string,
  orderId: string,
): void {
  try {
    store?.removeItem(pendingKey(userId, orderId));
  } catch {
    // ignore
  }
}

export function loadPendingRefund(
  store: KeyValueStore | null,
  userId: string,
  orderId: string,
  locationId: string,
): CreateOrderRefundRequest | null {
  let raw: string | null = null;
  try {
    raw = store?.getItem(pendingKey(userId, orderId)) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const ok =
      v.locationId === locationId &&
      typeof v.requestId === "string" &&
      Number.isSafeInteger(v.amountMinorUnits) &&
      typeof v.currency === "string" &&
      typeof v.reasonCode === "string" &&
      (ORDER_REFUND_REASON_CODES as readonly string[]).includes(v.reasonCode) &&
      Number.isSafeInteger(v.expectedReservedMinorUnits) &&
      (v.note === undefined || typeof v.note === "string");
    return ok ? (v as unknown as CreateOrderRefundRequest) : null;
  } catch {
    return null;
  }
}

export function browserSessionStore(): KeyValueStore | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

// --- the late-failure review note -------------------------------------------------------

export function validateReviewNote(note: string): string | null {
  const trimmed = note.trim();
  if (trimmed.length === 0) return "Add a note describing what you checked.";
  if (trimmed.length > ORDER_REFUND_NOTE_MAX_LENGTH) {
    return `Keep the note to ${ORDER_REFUND_NOTE_MAX_LENGTH} characters.`;
  }
  return null;
}

// --- the Orders workspace's "refunds owed" list ------------------------------------------

export function obligationsOwedFirst(
  items: readonly OrderRefundObligationListItem[],
): OrderRefundObligationListItem[] {
  // Needs attention first, then the most owed; the server's order otherwise.
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        Number(b.item.obligation.needsAttention) - Number(a.item.obligation.needsAttention) ||
        b.item.obligation.outstandingMinorUnits - a.item.obligation.outstandingMinorUnits ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

// The order-detail closing line, by status (a rejected or cancelled order is
// not "complete").
export function closedOrderLine(status: OrderStatus): string | null {
  switch (status) {
    case "COMPLETED":
      return "This order is complete.";
    case "REJECTED":
      return "This order was rejected.";
    case "CANCELLED":
      return "This order was cancelled.";
    default:
      return null;
  }
}
