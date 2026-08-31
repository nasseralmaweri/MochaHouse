"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { InternalUserStatus } from "@mocha-house/contracts";
import { updateInternalUserStatusFromBrowser } from "@/lib/api-client";
import {
  checkStatusChangeReason,
  userStatusActions,
  type UserStatusActionKey,
} from "@/lib/admin/user-access";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";

const COPY: Record<
  UserStatusActionKey,
  { heading: string; explanation: string; confirm: string }
> = {
  suspend: {
    heading: "Suspend access",
    explanation:
      "This person won’t be able to use the Mocha House Admin until their access is reactivated.",
    confirm: "Suspend access",
  },
  reactivate: {
    heading: "Reactivate",
    explanation:
      "This person will be able to use the Admin again with their existing access.",
    confirm: "Reactivate",
  },
  disable: {
    heading: "Disable account",
    explanation:
      "Disable this account? This person will no longer be able to use the Mocha House Admin. Their account and history will be kept.",
    confirm: "Disable account",
  },
};

// The Suspend / Reactivate / Disable control on a user's detail page
// (Milestone 5E-3). Rendered only when the actor may manage status and the
// target is not themselves. Every change needs a reason. The API is the
// authority — this island just collects the reason and surfaces the result.
export function UserStatusControl({
  internalUserId,
  status,
}: {
  internalUserId: string;
  status: InternalUserStatus;
}) {
  const router = useRouter();
  const actions = userStatusActions(status);

  const [openAction, setOpenAction] = useState<UserStatusActionKey | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function open(key: UserStatusActionKey) {
    setOpenAction(key);
    setReason("");
    setError(null);
    setNotice(null);
  }

  function close() {
    setOpenAction(null);
    setReason("");
    setError(null);
  }

  async function submit(key: UserStatusActionKey) {
    const targetStatus = actions.find((a) => a.key === key)?.targetStatus;
    if (!targetStatus) {
      return;
    }
    const checked = checkStatusChangeReason(reason);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }

    setPending(true);
    setError(null);
    const result = await updateInternalUserStatusFromBrowser(internalUserId, {
      status: targetStatus,
      reason: checked.reason,
    });

    if (result.outcome === "success") {
      close();
      setNotice("Status updated.");
      router.refresh();
      setPending(false);
      return;
    }

    setPending(false);
    if (result.outcome === "forbidden") {
      setError("You don’t have permission to change this person’s status.");
    } else if (result.outcome === "not-found") {
      setError("This user no longer exists.");
    } else {
      // invalid / conflict / error all carry a business-safe message.
      setError(result.message);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {openAction === null ? (
        <>
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => (
              <Button
                key={action.key}
                variant="secondary"
                onClick={() => open(action.key)}
              >
                {action.label}
              </Button>
            ))}
          </div>
          {notice ? (
            <p role="status" className="text-sm text-status-success">
              {notice}
            </p>
          ) : null}
        </>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border border-border-default bg-surface-subtle px-3 py-3">
          <p className="text-sm text-text-primary">
            {COPY[openAction].explanation}
          </p>
          <FormField label="Reason" htmlFor="status-reason">
            <textarea
              id="status-reason"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setError(null);
              }}
              rows={2}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          {error ? (
            <p role="alert" className="text-sm text-status-warning">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void submit(openAction)}
              disabled={pending}
            >
              {pending ? "Working…" : COPY[openAction].confirm}
            </Button>
            <Button variant="secondary" onClick={close} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
