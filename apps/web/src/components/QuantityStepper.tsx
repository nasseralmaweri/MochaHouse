"use client";

export function QuantityStepper({
  quantity,
  onChange,
  min = 1,
  label = "Quantity",
}: {
  quantity: number;
  onChange: (quantity: number) => void;
  min?: number;
  label?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      {label ? (
        <span className="text-sm font-medium text-text-primary">{label}</span>
      ) : null}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onChange(Math.max(min, quantity - 1))}
          disabled={quantity <= min}
          aria-label="Decrease quantity"
          className="flex h-11 w-11 items-center justify-center rounded-full border border-border-default text-lg font-semibold text-text-primary disabled:text-text-muted"
        >
          −
        </button>
        <span
          className="w-6 text-center text-base font-semibold text-text-primary"
          aria-live="polite"
        >
          {quantity}
        </span>
        <button
          type="button"
          onClick={() => onChange(quantity + 1)}
          aria-label="Increase quantity"
          className="flex h-11 w-11 items-center justify-center rounded-full border border-border-default text-lg font-semibold text-text-primary"
        >
          +
        </button>
      </div>
    </div>
  );
}
