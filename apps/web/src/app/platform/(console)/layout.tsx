import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PlatformShell } from "@/components/platform/PlatformShell";
import { PlatformAuthFrame, PlatformNotice } from "@/components/platform/PlatformAuthFrame";
import { centerivoSans } from "@/components/centerivo/fonts";
import { getPlatformSession } from "@/lib/platform-auth/session";

export const metadata: Metadata = {
  title: "CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// SC1b — the server-side boundary for every platform console page. The
// session is resolved by the API's GET /platform/me on every request (token
// re-verified, operator re-read, ACTIVE required). Fails closed:
//   no session        -> sign-in
//   expired / invalid -> sign-in, "your session has ended"
//   refused (403)     -> sign-in, "not permitted" (a DISABLED operator)
//   API unreachable   -> an unavailable page; no console content at all.
// Tenant-staff and customer sessions are different cookies and different
// API boundaries: they never satisfy this layout.
export default async function PlatformConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getPlatformSession();
  switch (session.state) {
    case "signed-out":
      redirect("/platform/sign-in");
    case "expired":
      redirect("/platform/sign-in?notice=expired");
    case "forbidden":
      redirect("/platform/sign-in?notice=not-permitted");
    case "unavailable":
      return (
        <PlatformAuthFrame
          title="Platform unavailable"
          subtitle="The CENTERIVO platform console cannot be reached right now."
        >
          <PlatformNotice tone="error">
            Your session could not be confirmed, so nothing is shown. Try
            again in a moment.
          </PlatformNotice>
        </PlatformAuthFrame>
      );
    case "signed-in":
      return (
        <div className={`${centerivoSans.variable} centerivo contents`}>
          <PlatformShell operator={session.operator}>{children}</PlatformShell>
        </div>
      );
  }
}
