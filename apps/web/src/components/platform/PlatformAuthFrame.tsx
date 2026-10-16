import { CenterivoWordmark } from "@/components/centerivo/Wordmark";
import { centerivoSans } from "@/components/centerivo/fonts";

// SC1b — the frame of the CENTERIVO platform-operator sign-in screens. The
// platform console's own identity: CENTERIVO, labelled "Platform Console",
// never a tenant's (Mocha House) branding.
export function PlatformAuthFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`${centerivoSans.variable} centerivo flex min-h-dvh flex-col items-center bg-surface-page px-4 py-12 sm:py-20`}
    >
      <div className="flex items-center gap-3">
        <CenterivoWordmark />
        <span className="rounded-full border border-border-default px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Platform Console
        </span>
      </div>
      <main className="mt-14 flex w-full max-w-sm flex-1 flex-col gap-8 sm:mt-20 sm:flex-none">
        <div className="flex flex-col gap-2">
          <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-text-primary">
            {title}
          </h1>
          <p className="text-[0.9375rem] text-text-secondary">{subtitle}</p>
        </div>
        <div
          className="rounded-2xl border border-border-default bg-surface-card p-6 sm:p-7"
          style={{ boxShadow: "var(--cx-shadow-raised)" }}
        >
          {children}
        </div>
        <p className="text-center text-xs text-text-secondary">
          For CENTERIVO platform operators only. Business staff sign in at
          the{" "}
          <a
            href="/internal/sign-in"
            className="font-medium text-text-primary underline underline-offset-4"
          >
            business sign-in page
          </a>
          .
        </p>
      </main>
    </div>
  );
}

export const platformInputClassName =
  "min-h-11 rounded-lg border border-border-default bg-surface-card px-3.5 py-2.5 text-base text-text-primary transition-colors hover:border-text-muted/50 focus-visible:border-focus focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus";

export const platformPrimaryButtonClassName =
  "flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-base font-semibold text-accent-contrast transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-disabled:cursor-wait aria-disabled:opacity-70";

// A form's error area: always mounted (so assistive technology reliably
// announces a message that appears in it), visible only when it has text.
export function PlatformLiveError({
  id,
  message,
}: {
  id: string;
  message: string | null;
}) {
  return (
    <div role="alert" aria-live="assertive" id={id}>
      {message ? (
        <p className="rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error">
          {message}
        </p>
      ) : null}
    </div>
  );
}

export function PlatformNotice({
  tone,
  children,
}: {
  tone: "info" | "error";
  children: React.ReactNode;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "error"
          ? "rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error"
          : "rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary"
      }
    >
      {children}
    </p>
  );
}
