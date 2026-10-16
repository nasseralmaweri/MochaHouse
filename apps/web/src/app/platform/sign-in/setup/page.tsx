import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PlatformAuthFrame } from "@/components/platform/PlatformAuthFrame";
import { PlatformCodeForm } from "@/components/platform/PlatformCodeForm";
import { CopySetupKey } from "@/components/platform/CopySetupKey";
import {
  getPlatformChallenge,
  getPlatformEnrolment,
} from "@/lib/platform-auth/session";
import { groupSecret } from "@/lib/platform-auth/sign-in-flow";

export const metadata: Metadata = {
  title: "Set up your authenticator · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// SC1b — first sign-in only: add CENTERIVO to an authenticator app, then
// confirm with its first code. The secret is held by the API with the
// in-progress attempt (never in a cookie), read here on the server with the
// attempt's handle, and rendered for the operator to type, copy or open — it
// is never held in client-side state. It expires with the attempt (3 min).
export default async function PlatformSetupPage() {
  const challenge = await getPlatformChallenge();
  const enrolment = challenge ? await getPlatformEnrolment(challenge) : null;
  if (!enrolment) {
    redirect("/platform/sign-in?notice=restart");
  }

  return (
    <PlatformAuthFrame
      title="Set up two-step verification"
      subtitle="Every CENTERIVO platform sign-in needs a code from an authenticator app."
    >
      <div className="flex flex-col gap-6">
        <ol className="list-decimal space-y-3 pl-5 text-sm text-text-primary">
          <li>
            Open an authenticator app (for example Google Authenticator,
            Microsoft Authenticator or 1Password) and add an account.
          </li>
          <li>
            Choose to enter a setup key, and enter this key:
            <code
              id="platform-setup-key"
              className="mt-2 block break-all rounded-lg border border-border-default bg-surface-subtle px-3 py-2 font-mono text-base tracking-wider"
            >
              {groupSecret(enrolment.secret)}
            </code>
            <CopySetupKey targetId="platform-setup-key" />
            <a
              href={enrolment.otpauthUri}
              className="mt-2 block text-sm font-medium text-text-primary underline underline-offset-4"
            >
              Or open it in an authenticator app on this device
            </a>
          </li>
          <li>Enter the 6-digit code the app now shows for CENTERIVO.</li>
        </ol>
        <PlatformCodeForm mode="enrol" />
        <p className="text-xs text-text-secondary">
          This setup expires after 3 minutes. Keep the key private and do
          not store it anywhere else. If you lose your authenticator, a
          CENTERIVO administrator can reset it.
        </p>
      </div>
    </PlatformAuthFrame>
  );
}
