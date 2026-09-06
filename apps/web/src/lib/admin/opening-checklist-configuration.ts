import type { OpeningChecklistTemplateConfigResponse } from "@mocha-house/contracts";

// Framework-free view-model + validation logic for the HQ Opening Checklist
// configuration page (Milestone 6B-2), matching the rest of lib/admin. It
// makes NO authorization decision — every API call the page performs is
// guarded server-side by `operations.checklists.configure` (CORPORATE). It
// only shapes what the editor renders and validates input before a request.

// The exact, approved wording for the persistent notice on the page. The
// behaviour is INSTANCE-based, not "tomorrow": a location that has already
// created today's checklist keeps its snapshot; a location that has not yet
// created today's picks up the new template when its instance is created.
export const CHECKLIST_CONFIG_EFFECT_NOTICE =
  "Changes apply the next time a location creates its Opening Checklist. " +
  "Checklists already created are not changed.";

export const CHECKLIST_ITEM_LABEL_MAX_LENGTH = 500;
export const CHECKLIST_SECTION_NAME_MAX_LENGTH = 120;

// How the configuration page maps an API call outcome to its own state.
export type ChecklistConfigLoadOutcome =
  | "success"
  | "forbidden"
  | "not-found"
  | "invalid"
  | "error";

export type ChecklistConfigLoadState = "ok" | "forbidden" | "error";

// A failed INITIAL load must land on the retryable error card, never stay
// on the loading skeleton. `invalid` cannot occur on GET but is mapped for
// completeness.
export function nextChecklistConfigLoadState(
  outcome: ChecklistConfigLoadOutcome,
): ChecklistConfigLoadState {
  switch (outcome) {
    case "success":
      return "ok";
    case "forbidden":
      return "forbidden";
    case "not-found":
    case "invalid":
    case "error":
      return "error";
  }
}

// Case- and whitespace-insensitive section identity — mirrors the server's
// `canonicalName`, so the UI can warn about a near-duplicate section name
// before the request (the server remains the authority).
export function canonicalSectionName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export type FieldResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function validateChecklistItemLabel(raw: string): FieldResult {
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, error: "Enter the wording for this item." };
  }
  if (value.length > CHECKLIST_ITEM_LABEL_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep the wording under ${CHECKLIST_ITEM_LABEL_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, value };
}

export function validateChecklistSectionName(raw: string): FieldResult {
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, error: "Enter a section name." };
  }
  if (value.length > CHECKLIST_SECTION_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep the section name under ${CHECKLIST_SECTION_NAME_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, value };
}

// One item, prepared for rendering. `canMoveUp/Down` come straight from the
// authoritative API projection (reorder is within-section only in 6B-2).
export interface ChecklistTemplateItemViewModel {
  id: string;
  label: string;
  isActive: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

export interface ChecklistTemplateSectionViewModel {
  name: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  items: ChecklistTemplateItemViewModel[];
}

export interface ChecklistTemplateViewModel {
  title: string;
  sections: ChecklistTemplateSectionViewModel[];
  // Existing section names, in display order — the options for the
  // "add item" section picker.
  sectionNames: string[];
  totalItems: number;
  activeItems: number;
  inactiveItems: number;
}

export function buildChecklistTemplateViewModel(
  template: OpeningChecklistTemplateConfigResponse,
): ChecklistTemplateViewModel {
  const sections: ChecklistTemplateSectionViewModel[] = template.sections.map(
    (section) => ({
      name: section.name,
      canMoveUp: section.canMoveUp,
      canMoveDown: section.canMoveDown,
      items: section.items.map((item) => ({
        id: item.id,
        label: item.label,
        isActive: item.isActive,
        canMoveUp: item.canMoveUp,
        canMoveDown: item.canMoveDown,
      })),
    }),
  );

  const allItems = sections.flatMap((s) => s.items);
  const activeItems = allItems.filter((i) => i.isActive).length;

  return {
    title: template.title,
    sections,
    sectionNames: sections.map((s) => s.name),
    totalItems: allItems.length,
    activeItems,
    inactiveItems: allItems.length - activeItems,
  };
}

// Does `name` name a section that already exists (ignoring case/whitespace)?
// Used to (a) route an "add item" to the existing section and (b) warn on a
// rename that would collide.
export function matchesExistingSection(
  template: OpeningChecklistTemplateConfigResponse,
  name: string,
): string | null {
  const target = canonicalSectionName(name);
  const match = template.sections.find(
    (s) => canonicalSectionName(s.name) === target,
  );
  return match ? match.name : null;
}
