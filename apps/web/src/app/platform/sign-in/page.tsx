import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  PlatformAuthFrame,
  PlatformNotice,
} from "@/components/platform/PlatformAuthFrame";
import { PlatformSignInForm } from "@/components/platform/PlatformSignInForm";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { PLATFORM_NOTICES, noticeFrom } from "@/lib/platform-auth/sign-in-flow";

export const metadata: Metadata = {
  title: "Sign in · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// SC1b — the CENTERIVO platform-operator sign-in (step 1 of 2). There is no
// "create an account" or "forgot password" link: operators are provisioned
// by a CENTERIVO administrator, and every sign-in also needs an
// authenticator code.
export default async function PlatformSignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getPlatformSession();
  if (session.state === "signed-in") {
    redirect("/platform");
  }
  const notice = noticeFrom((await searchParams).notice);

  return (
    <PlatformAuthFrame
      title="Platform sign-in"
      subtitle="Sign in to administer the CENTERIVO platform."
    >
      <div className="flex flex-col gap-5">
        {session.state === "unavailable" ? (
          <PlatformNotice tone="error">
            The platform cannot be reached right now. Try again shortly.
          </PlatformNotice>
        ) : null}
        {notice ? (
          <PlatformNotice tone={notice === "signed-out" ? "info" : "error"}>
            {PLATFORM_NOTICES[notice]}
          </PlatformNotice>
        ) : null}
        <PlatformSignInForm />
      </div>
    </PlatformAuthFrame>
  );
}
