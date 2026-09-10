"use client";

import { useState } from "react";
import type { JobApplicationNote } from "@mocha-house/contracts";
import { JOB_APPLICATION_NOTE_MAX_LENGTH } from "@mocha-house/contracts";
import { addJobApplicationNoteFromBrowser } from "@/lib/api-client";
import { formatApplicantDate } from "@/lib/admin/applicants";
import { Card } from "@/components/Card";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS, FormField } from "./form";

// Admin → Applicant detail → Internal notes (Milestone 8C). APPEND-ONLY: a
// list plus an add form. The add form renders only when `canManage` (the
// page has already checked `applicants.manage`); the API re-checks. There is
// no edit or delete. The note body is never written to the audit log.
export function ApplicationNotesPanel({
  applicationId,
  initialNotes,
  canManage,
}: {
  applicationId: string;
  initialNotes: JobApplicationNote[];
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
    const result = await addJobApplicationNoteFromBrowser(applicationId, body);
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
          : "That application could not be found.",
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {canManage ? (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <FormField
            label="Add an internal note"
            htmlFor="applicant-note"
            hint={`Only Mocha House staff see this. Up to ${JOB_APPLICATION_NOTE_MAX_LENGTH} characters. Notes cannot be edited or deleted.`}
            error={error}
          >
            <textarea
              id="applicant-note"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              maxLength={JOB_APPLICATION_NOTE_MAX_LENGTH}
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
          No internal notes on this application yet.
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
                  {note.authorLabel ?? "Unknown"} ·{" "}
                  {formatApplicantDate(note.createdAt)}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
