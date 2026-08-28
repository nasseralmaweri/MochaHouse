"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "mocha-house-cart";
const CART_VERSION = 1;

export interface CartLineSelection {
  groupId: string;
  groupName: string;
  optionIds: string[];
  optionNames: string[];
}

export interface CartLine {
  lineId: string;
  productId: string;
  productName: string;
  currency: string;
  menuId: string;
  locationId: string;
  quantity: number;
  selections: CartLineSelection[];
  // Cached at add/edit time for immediate display only. Never authoritative
  // — /order/cart always revalidates against the live effective menu, and
  // this value is never trusted as the final price.
  unitPriceAtAdd: number;
}

interface CartSnapshot {
  version: typeof CART_VERSION;
  locationId: string | null;
  locationName: string | null;
  lines: CartLine[];
}

const emptyState: CartSnapshot = {
  version: CART_VERSION,
  locationId: null,
  locationName: null,
  lines: [],
};

export interface AddItemInput {
  productId: string;
  productName: string;
  currency: string;
  menuId: string;
  locationId: string;
  locationName: string;
  quantity: number;
  selections: CartLineSelection[];
  unitPriceAtAdd: number;
}

export type AddItemResult =
  | { ok: true; lineId: string }
  | { ok: false; reason: "location-conflict" };

// The cart is a plain module-level store (not React state) so every
// consumer — the header cart badge, the customizer, the cart page — reads
// and writes the same single source of truth, synced through localStorage
// via useSyncExternalStore rather than useState+useEffect. That hook is
// what lets the client-only localStorage value hydrate in after the
// server-matching first paint without a hydration mismatch.
let state: CartSnapshot = emptyState;
let hydrated = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

function hydrateFromStorageOnce() {
  if (hydrated || typeof window === "undefined") {
    return;
  }
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CartSnapshot;
      if (parsed.version === CART_VERSION) {
        state = parsed;
      }
    }
  } catch {
    // Corrupt/unreadable storage — start from an empty cart.
  }
}

function persist() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function setState(next: CartSnapshot) {
  state = next;
  persist();
  notify();
}

function subscribe(listener: () => void): () => void {
  hydrateFromStorageOnce();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CartSnapshot {
  hydrateFromStorageOnce();
  return state;
}

function getServerSnapshot(): CartSnapshot {
  return emptyState;
}

function getHydratedSnapshot(): boolean {
  hydrateFromStorageOnce();
  return hydrated;
}

function getHydratedServerSnapshot(): boolean {
  return false;
}

function lineSignature(
  productId: string,
  selections: CartLineSelection[],
): string {
  const normalized = [...selections]
    .map((selection) => ({
      groupId: selection.groupId,
      optionIds: [...selection.optionIds].sort(),
    }))
    .sort((a, b) => a.groupId.localeCompare(b.groupId));
  return `${productId}::${JSON.stringify(normalized)}`;
}

function createLineId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `line-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function addItem(input: AddItemInput): AddItemResult {
  const current = state;

  if (
    current.locationId &&
    current.locationId !== input.locationId &&
    current.lines.length > 0
  ) {
    return { ok: false, reason: "location-conflict" };
  }

  const signature = lineSignature(input.productId, input.selections);
  const existingLine = current.lines.find(
    (line) => lineSignature(line.productId, line.selections) === signature,
  );

  if (existingLine) {
    setState({
      ...current,
      locationId: input.locationId,
      locationName: input.locationName,
      lines: current.lines.map((line) =>
        line.lineId === existingLine.lineId
          ? { ...line, quantity: line.quantity + input.quantity }
          : line,
      ),
    });
    return { ok: true, lineId: existingLine.lineId };
  }

  const lineId = createLineId();
  setState({
    ...current,
    locationId: input.locationId,
    locationName: input.locationName,
    lines: [
      ...current.lines,
      {
        lineId,
        productId: input.productId,
        productName: input.productName,
        currency: input.currency,
        menuId: input.menuId,
        locationId: input.locationId,
        quantity: input.quantity,
        selections: input.selections,
        unitPriceAtAdd: input.unitPriceAtAdd,
      },
    ],
  });
  return { ok: true, lineId };
}

function replaceCartWithItem(input: AddItemInput) {
  setState({
    version: CART_VERSION,
    locationId: input.locationId,
    locationName: input.locationName,
    lines: [
      {
        lineId: createLineId(),
        productId: input.productId,
        productName: input.productName,
        currency: input.currency,
        menuId: input.menuId,
        locationId: input.locationId,
        quantity: input.quantity,
        selections: input.selections,
        unitPriceAtAdd: input.unitPriceAtAdd,
      },
    ],
  });
}

export interface ReplaceCartInput {
  locationId: string;
  locationName: string;
  lines: {
    productId: string;
    productName: string;
    currency: string;
    menuId: string;
    quantity: number;
    selections: CartLineSelection[];
    unitPriceAtAdd: number;
  }[];
}

// Wholesale cart replacement — used only by the reorder flow, after the
// customer has explicitly reviewed the reorder preparation and confirmed.
// Never merges: whatever was in the cart (including a different location's
// items) is discarded. Callers own asking for that confirmation first.
function replaceCart(input: ReplaceCartInput) {
  setState({
    version: CART_VERSION,
    locationId: input.locationId,
    locationName: input.locationName,
    lines: input.lines.map((line) => ({
      lineId: createLineId(),
      productId: line.productId,
      productName: line.productName,
      currency: line.currency,
      menuId: line.menuId,
      locationId: input.locationId,
      quantity: line.quantity,
      selections: line.selections,
      unitPriceAtAdd: line.unitPriceAtAdd,
    })),
  });
}

function updateLine(
  lineId: string,
  changes: {
    selections: CartLineSelection[];
    quantity: number;
    unitPriceAtAdd: number;
  },
) {
  setState({
    ...state,
    lines: state.lines.map((line) =>
      line.lineId === lineId ? { ...line, ...changes } : line,
    ),
  });
}

function removeLine(lineId: string) {
  const lines = state.lines.filter((line) => line.lineId !== lineId);
  setState({
    ...state,
    lines,
    locationId: lines.length > 0 ? state.locationId : null,
    locationName: lines.length > 0 ? state.locationName : null,
  });
}

function setLineQuantity(lineId: string, quantity: number) {
  const safeQuantity = Math.max(1, Math.floor(quantity));
  setState({
    ...state,
    lines: state.lines.map((line) =>
      line.lineId === lineId ? { ...line, quantity: safeQuantity } : line,
    ),
  });
}

function clearCart() {
  setState(emptyState);
}

export function useCart() {
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const isHydrated = useSyncExternalStore(
    subscribe,
    getHydratedSnapshot,
    getHydratedServerSnapshot,
  );

  const itemCount = snapshot.lines.reduce(
    (sum, line) => sum + line.quantity,
    0,
  );

  return {
    locationId: snapshot.locationId,
    locationName: snapshot.locationName,
    lines: snapshot.lines,
    isHydrated,
    itemCount,
    // Module-level functions — stable references, no useCallback needed.
    addItem,
    replaceCartWithItem,
    replaceCart,
    updateLine,
    removeLine,
    setLineQuantity,
    clearCart,
  };
}
