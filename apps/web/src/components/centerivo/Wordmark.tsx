// The CENTERIVO platform identity: a navy "C" held in a quiet ring around a
// warm-gold centre, and a widely tracked wordmark. Deliberately understated —
// it identifies the platform, it does not compete with the business the
// person is working in.
export function CenterivoMark({
  className = "h-6 w-6",
}: {
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 text-accent ${className}`}
    >
      <circle
        cx="16"
        cy="16"
        r="14.5"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.3"
      />
      <path
        d="M22 10.5a8 8 0 1 0 0 11"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="2.4" fill="var(--accent-gold)" />
    </svg>
  );
}

export function CenterivoWordmark({ showText = true }: { showText?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <CenterivoMark />
      {showText ? (
        <span className="text-[0.8125rem] font-semibold tracking-[0.22em] text-accent">
          CENTERIVO
        </span>
      ) : (
        <span className="sr-only">CENTERIVO</span>
      )}
    </span>
  );
}
