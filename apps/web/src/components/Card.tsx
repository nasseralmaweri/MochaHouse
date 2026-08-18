export function Card({
  tone = "default",
  className = "",
  children,
}: {
  tone?: "default" | "subtle";
  className?: string;
  children: React.ReactNode;
}) {
  const toneClass = tone === "subtle" ? "bg-surface-subtle" : "bg-surface-card";

  return (
    <div
      className={`rounded-xl border border-border-default px-4 py-4 ${toneClass} ${className}`}
    >
      {children}
    </div>
  );
}
