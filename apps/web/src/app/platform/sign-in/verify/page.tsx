import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PlatformAuthFrame } from "@/components/platform/PlatformAuthFrame";
import { PlatformCodeForm } from "@/components/platform/PlatformCodeForm";
import { getPlatformChallenge } from "@/lib/platform-auth/session";

export const metadata: Metadata = {
  title: "Verify · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// SC1b — step 2 of 2: the authenticator code. Only reachable with an
// in-progress sign-in (the HttpOnly challenge cookie); otherwise back to the
// start.
export default async function PlatformVerifyPage() {
  if (!(await getPlatformChallenge())) {
    redirect("/platform/sign-in?notice=restart");
  }
  return (
    <PlatformAuthFrame
      title="Enter your code"
      subtitle="Open your authenticator app and enter the 6-digit code for CENTERIVO."
    >
      <div className="flex flex-col gap-4">
        <PlatformCodeForm mode="verify" />
        <p className="text-xs text-text-muted">
          Lost access to your authenticator? A CENTERIVO administrator can
          reset it for you after confirming who you are.
        </p>
      </div>
    </PlatformAuthFrame>
  );
}
