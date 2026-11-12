"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  invitationMessage,
  sendLoginInvitationFromBrowser,
} from "@/lib/admin/staff-invitation";
import { Button } from "./Button";

// V1 launch fix 2 — send an invited employee's sign-in invitation again
// (it was not sent, or the temporary password expired). The identity
// provider never changes a sign-in that has already been set up.
export function SendLoginInvitation({
  internalUserId,
  email,
}: {
  internalUserId: string;
  email: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const sending = useRef(false);

  async function send() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await sendLoginInvitationFromBrowser(internalUserId);
      if (result.outcome === "success") {
        setMessage(invitationMessage(result.data.invitation, email));
        router.refresh();
      } else if (result.outcome === "not-found") {
        setMessage("This person no longer exists here.");
      } else {
        setMessage(result.message);
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" className="sm:self-start" disabled={busy} onClick={() => void send()}>
        {busy ? "Sending…" : "Send invitation again"}
      </Button>
      <div role="status" aria-live="polite">
        {message ? <p className="text-sm text-text-primary">{message}</p> : null}
      </div>
    </div>
  );
}
