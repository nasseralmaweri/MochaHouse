"use client";

import { ChecklistExecutionPage } from "@/components/admin/ChecklistExecutionPage";

// Admin → Operations → Today → Closing Checklist (Milestone 6D). Identical
// to the Opening Checklist page — the shared ChecklistExecutionPage bound
// to the Closing checklist.
export default function ClosingChecklistPage() {
  return <ChecklistExecutionPage checklist="closing" />;
}
