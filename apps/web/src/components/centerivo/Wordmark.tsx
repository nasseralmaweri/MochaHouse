// The CENTERIVO platform identity: a quiet "centre" glyph and a lightly
// tracked wordmark. Deliberately understated — it identifies the platform,
// it does not compete with the business the person is working in.
export function CenterivoMark({
  className = "h-6 w-6",
}: {
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <rect width="24" height="24" rx="7" fill="var(--accent)" />
      <circle
        cx="12"
        cy="12"
        r="5.5"
        stroke="var(--accent-contrast)"
        strokeWidth="1.6"
      />
      <circle cx="12" cy="12" r="1.7" fill="var(--accent-contrast)" />
    </svg>
  );
}

export function CenterivoWordmark({
  showText = true,
}: {
  showText?: boolean;
}) {
  return (
    <span className="flex items-center gap-2.5">
      <CenterivoMark />
      {showText ? (
        <span className="text-[0.8125rem] font-semibold tracking-[0.18em] text-text-primary">
          CENTERIVO
        </span>
      ) : (
        <span className="sr-only">CENTERIVO</span>
      )}
    </span>
  );
}
