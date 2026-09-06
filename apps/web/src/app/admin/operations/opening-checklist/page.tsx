"use client";

import { ChecklistExecutionPage } from "@/components/admin/ChecklistExecutionPage";

// Admin → Operations → Today → Opening Checklist (Milestone 6B; 6C
// management exception). All behaviour is in the shared
// ChecklistExecutionPage — this only binds it to the Opening checklist.
export default function OpeningChecklistPage() {
  return <ChecklistExecutionPage checklist="opening" />;
}
