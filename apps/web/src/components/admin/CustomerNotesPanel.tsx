"use client";

import { useState } from "react";
import type { CustomerNote } from "@mocha-house/contracts";
import { CUSTOMER_NOTE_MAX_LENGTH } from "@mocha-house/contracts";
import { addCustomerNoteFromBrowser } from "@/lib/api-client";
import { formatCrmDate } from "@/lib/admin/crm";
import { Card } from "@/components/Card";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS, FormField } from "./form";

// Admin → Customer detail → Notes (Milestone 8A). APPEND-ONLY: a list plus
// an add form. The add form renders only when `canManage` (the page has
// already checked `customers.notes.manage`); the API re-checks. There is no
// edit or delete.
export function CustomerNotesPanel({
  customerId,
  initialNotes,
  canManage,
}: {
  customerId: string;
  initialNotes: CustomerNote[];
  canManage: boolean;
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const body = draft.trim();
    if (body.length === 0) {
      setError("Enter a note.");
      return;
    }
    setPending(true);
    const result = await addCustomerNoteFromBrowser(customerId, body);
    setPending(false);
    if (result.outcome === "success") {
      setNotes(result.notes);
      setDraft("");
      return;
    }
    setError(
      result.outcome === "invalid" || result.outcome === "error"
        ? result.message
        : result.outcome === "forbidden"
          ? "You no longer have permission to add notes."
          : "That customer could not be found.",
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {canManage ? (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <FormField
            label="Add an internal note"
            htmlFor="crm-note"
            hint={`Only Mocha House staff see this. Up to ${CUSTOMER_NOTE_MAX_LENGTH} characters. Notes cannot be edited or deleted.`}
            error={error}
          >
            <textarea
              id="crm-note"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              maxLength={CUSTOMER_NOTE_MAX_LENGTH}
              className={`${ADMIN_FIELD_CLASS} resize-y`}
            />
          </FormField>
          <Button type="submit" disabled={pending} className="self-start">
            {pending ? "Saving…" : "Add note"}
          </Button>
        </form>
      ) : null}

      {notes.length === 0 ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          No internal notes on this customer yet.
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map((note) => (
            <li key={note.id}>
              <Card className="flex flex-col gap-1">
                <p className="whitespace-pre-wrap text-sm text-text-primary">
                  {note.body}
                </p>
                <p className="text-xs text-text-muted">
                  {note.authorLabel ?? "Unknown"} · {formatCrmDate(note.createdAt)}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
