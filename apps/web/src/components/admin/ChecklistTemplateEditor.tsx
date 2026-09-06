"use client";

import { useCallback, useEffect, useState } from "react";
import type { OpeningChecklistTemplateConfigResponse } from "@mocha-house/contracts";
import {
  addChecklistTemplateItemFromBrowser,
  getChecklistTemplateFromBrowser,
  moveChecklistTemplateItemFromBrowser,
  moveChecklistTemplateSectionFromBrowser,
  renameChecklistTemplateSectionFromBrowser,
  updateChecklistTemplateItemFromBrowser,
  type ChecklistKind,
  type ChecklistTemplateConfigResult,
} from "@/lib/api-client";
import {
  CHECKLIST_CONFIG_EFFECT_NOTICE,
  buildChecklistTemplateViewModel,
  matchesExistingSection,
  nextChecklistConfigLoadState,
  validateChecklistItemLabel,
  validateChecklistSectionName,
  type ChecklistConfigLoadState,
  type ChecklistTemplateItemViewModel,
} from "@/lib/admin/checklist-configuration";
import { AdminSection } from "@/components/admin/AdminPage";
import { AdminErrorState, AdminForbidden, AdminLoading } from "@/components/admin/states";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/Card";
import { ADMIN_FIELD_CLASS, FormField } from "@/components/admin/form";
import { StatusBadge } from "@/components/admin/StatusBadge";

const NEW_SECTION = "__new__";

// The HQ daily-checklist template editor (Milestone 6B-2 Opening; 6D
// Closing — the two share this verbatim, bound by the `checklist` prop). A
// card/list experience for managing a straightforward operating procedure
// — not a dense builder. The server is the authority: every mutation
// returns the whole template and the editor reconciles from it. Reorder
// and Active/Inactive apply immediately; wording and section renames use
// an explicit Save.
export function ChecklistTemplateEditor({
  checklist,
}: {
  checklist: ChecklistKind;
}) {
  const [template, setTemplate] =
    useState<OpeningChecklistTemplateConfigResponse | null>(null);
  const [state, setState] = useState<ChecklistConfigLoadState>("ok");
  const [notice, setNotice] = useState<string | null>(null);
  // Keys of operations in flight — disables the affected controls.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [renamingSection, setRenamingSection] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);

  const applyResult = useCallback(
    (result: ChecklistTemplateConfigResult): boolean => {
      if (result.outcome === "success") {
        setState("ok");
        setNotice(null);
        setTemplate(result.template);
        return true;
      }
      setState(nextChecklistConfigLoadState(result.outcome));
      if (result.outcome === "invalid" || result.outcome === "error") {
        setNotice(result.message);
      } else if (result.outcome === "not-found") {
        setNotice("The checklist template could not be found.");
      }
      return false;
    },
    [],
  );

  const load = useCallback(async () => {
    applyResult(await getChecklistTemplateFromBrowser(checklist));
  }, [applyResult, checklist]);

  useEffect(() => {
    let cancelled = false;
    getChecklistTemplateFromBrowser(checklist).then((result) => {
      if (!cancelled) applyResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [applyResult, checklist]);

  const run = useCallback(
    async (
      key: string,
      action: () => Promise<ChecklistTemplateConfigResult>,
      onDone?: () => void,
    ) => {
      if (pending.has(key)) return;
      setPending((current) => new Set(current).add(key));
      setNotice(null);
      try {
        const ok = applyResult(await action());
        if (ok) onDone?.();
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [applyResult, pending],
  );

  if (state === "forbidden") {
    return <AdminForbidden />;
  }
  if (state === "error" && !template) {
    return (
      <AdminErrorState
        description="Couldn't load the checklist configuration."
        onRetry={() => void load()}
      />
    );
  }
  if (!template) {
    return <AdminLoading label="Loading the checklist configuration" />;
  }

  const vm = buildChecklistTemplateViewModel(template);

  return (
    <div className="flex flex-col gap-6">
      <Card tone="subtle" className="text-sm text-text-secondary">
        {CHECKLIST_CONFIG_EFFECT_NOTICE}
      </Card>

      <p className="text-sm text-text-muted">
        {vm.totalItems} item{vm.totalItems === 1 ? "" : "s"} · {vm.activeItems}{" "}
        active · {vm.inactiveItems} inactive
      </p>

      {notice ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          {notice}
        </Card>
      ) : null}

      {vm.sections.map((section, sectionIndex) => (
        <AdminSection key={section.name} title={section.name}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={
                  !section.canMoveUp || pending.has(`section-move:${section.name}`)
                }
                onClick={() =>
                  void run(`section-move:${section.name}`, () =>
                    moveChecklistTemplateSectionFromBrowser(
                      checklist,
                      section.name,
                      "up",
                    ),
                  )
                }
              >
                ↑ Move section up
              </Button>
              <Button
                variant="secondary"
                disabled={
                  !section.canMoveDown ||
                  pending.has(`section-move:${section.name}`)
                }
                onClick={() =>
                  void run(`section-move:${section.name}`, () =>
                    moveChecklistTemplateSectionFromBrowser(
                      checklist,
                      section.name,
                      "down",
                    ),
                  )
                }
              >
                ↓ Move section down
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  setRenamingSection((current) =>
                    current === section.name ? null : section.name,
                  )
                }
              >
                Rename section
              </Button>
              <span className="text-xs text-text-muted">
                Section {sectionIndex + 1} of {vm.sections.length}
              </span>
            </div>

            {renamingSection === section.name ? (
              <SectionRenameForm
                currentName={section.name}
                template={template}
                busy={pending.has(`section-rename:${section.name}`)}
                onCancel={() => setRenamingSection(null)}
                onSave={(to) =>
                  void run(
                    `section-rename:${section.name}`,
                    () =>
                      renameChecklistTemplateSectionFromBrowser(checklist, {
                        from: section.name,
                        to,
                      }),
                    () => setRenamingSection(null),
                  )
                }
              />
            ) : null}

            <ul className="flex flex-col gap-2">
              {section.items.map((item) => (
                <li key={item.id}>
                  <ItemRow
                    item={item}
                    editing={editingItemId === item.id}
                    busy={pending.has(`item:${item.id}`)}
                    onStartEdit={() => setEditingItemId(item.id)}
                    onCancelEdit={() => setEditingItemId(null)}
                    onSaveLabel={(label) =>
                      void run(
                        `item:${item.id}`,
                        () =>
                          updateChecklistTemplateItemFromBrowser(
                            checklist,
                            item.id,
                            { label },
                          ),
                        () => setEditingItemId(null),
                      )
                    }
                    onToggleActive={(isActive) =>
                      void run(`item:${item.id}`, () =>
                        updateChecklistTemplateItemFromBrowser(
                          checklist,
                          item.id,
                          { isActive },
                        ),
                      )
                    }
                    onMove={(direction) =>
                      void run(`item:${item.id}`, () =>
                        moveChecklistTemplateItemFromBrowser(
                          checklist,
                          item.id,
                          direction,
                        ),
                      )
                    }
                  />
                </li>
              ))}
            </ul>

            {addingTo === section.name ? (
              <AddItemForm
                busy={pending.has(`add:${section.name}`)}
                onCancel={() => setAddingTo(null)}
                onAdd={(label) =>
                  void run(
                    `add:${section.name}`,
                    () =>
                      addChecklistTemplateItemFromBrowser(checklist, {
                        section: section.name,
                        label,
                      }),
                    () => setAddingTo(null),
                  )
                }
              />
            ) : (
              <div>
                <Button
                  variant="secondary"
                  onClick={() => setAddingTo(section.name)}
                >
                  + Add item to this section
                </Button>
              </div>
            )}
          </div>
        </AdminSection>
      ))}

      <AdminSection title="Add an item under a new section">
        {addingTo === NEW_SECTION ? (
          <AddItemToNewSectionForm
            template={template}
            busy={pending.has(`add:${NEW_SECTION}`)}
            onCancel={() => setAddingTo(null)}
            onAdd={(sectionName, label) =>
              void run(
                `add:${NEW_SECTION}`,
                () =>
                  addChecklistTemplateItemFromBrowser(checklist, {
                    section: sectionName,
                    label,
                  }),
                () => setAddingTo(null),
              )
            }
          />
        ) : (
          <div>
            <Button variant="secondary" onClick={() => setAddingTo(NEW_SECTION)}>
              + Add item to a new section
            </Button>
          </div>
        )}
      </AdminSection>
    </div>
  );
}

function ItemRow({
  item,
  editing,
  busy,
  onStartEdit,
  onCancelEdit,
  onSaveLabel,
  onToggleActive,
  onMove,
}: {
  item: ChecklistTemplateItemViewModel;
  editing: boolean;
  busy: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveLabel: (label: string) => void;
  onToggleActive: (isActive: boolean) => void;
  onMove: (direction: "up" | "down") => void;
}) {
  return (
    <Card
      className={`flex flex-col gap-3 ${
        item.isActive ? "" : "border-dashed opacity-70"
      }`}
    >
      {editing ? (
        // Mounted only while editing, so the draft always initialises from
        // the current wording — no synchronising effect needed.
        <ItemLabelEditor
          key={item.id}
          item={item}
          busy={busy}
          onCancel={onCancelEdit}
          onSave={onSaveLabel}
        />
      ) : (
        <>
          <p className="text-sm text-text-primary">{item.label}</p>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              label={item.isActive ? "Active" : "Inactive"}
              tone={item.isActive ? "positive" : "neutral"}
            />
            <Button variant="secondary" disabled={busy} onClick={onStartEdit}>
              Edit wording
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => onToggleActive(!item.isActive)}
            >
              {item.isActive ? "Make inactive" : "Make active"}
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !item.canMoveUp}
              onClick={() => onMove("up")}
            >
              ↑ Up
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !item.canMoveDown}
              onClick={() => onMove("down")}
            >
              ↓ Down
            </Button>
          </div>
          {!item.isActive ? (
            <p className="text-xs text-text-muted">
              Left off each location&rsquo;s next checklist. Still counted here
              so you can bring it back.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

function ItemLabelEditor({
  item,
  busy,
  onCancel,
  onSave,
}: {
  item: ChecklistTemplateItemViewModel;
  busy: boolean;
  onCancel: () => void;
  onSave: (label: string) => void;
}) {
  const [draft, setDraft] = useState(item.label);
  const [error, setError] = useState<string | null>(null);

  function save() {
    const result = validateChecklistItemLabel(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSave(result.value);
  }

  return (
    <>
      <FormField label="Item wording" htmlFor={`item-${item.id}`} error={error}>
        <textarea
          id={`item-${item.id}`}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          rows={2}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save wording"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  );
}

function AddItemForm({
  busy,
  onCancel,
  onAdd,
}: {
  busy: boolean;
  onCancel: () => void;
  onAdd: (label: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const result = validateChecklistItemLabel(label);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onAdd(result.value);
  }

  return (
    <Card tone="subtle" className="flex flex-col gap-3">
      <FormField label="New item wording" htmlFor="add-item-label" error={error}>
        <textarea
          id="add-item-label"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
            setError(null);
          }}
          rows={2}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={submit}>
          {busy ? "Adding…" : "Add item"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function AddItemToNewSectionForm({
  template,
  busy,
  onCancel,
  onAdd,
}: {
  template: OpeningChecklistTemplateConfigResponse;
  busy: boolean;
  onCancel: () => void;
  onAdd: (sectionName: string, label: string) => void;
}) {
  const [sectionName, setSectionName] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const sectionResult = validateChecklistSectionName(sectionName);
    if (!sectionResult.ok) {
      setError(sectionResult.error);
      return;
    }
    const labelResult = validateChecklistItemLabel(label);
    if (!labelResult.ok) {
      setError(labelResult.error);
      return;
    }
    const existing = matchesExistingSection(template, sectionResult.value);
    if (existing) {
      setError(
        `“${existing}” already exists — add the item to that section instead.`,
      );
      return;
    }
    onAdd(sectionResult.value, labelResult.value);
  }

  return (
    <Card tone="subtle" className="flex flex-col gap-3">
      <FormField label="New section name" htmlFor="add-section-name">
        <input
          id="add-section-name"
          value={sectionName}
          onChange={(event) => {
            setSectionName(event.target.value);
            setError(null);
          }}
          autoComplete="off"
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
        />
      </FormField>
      <FormField
        label="First item wording"
        htmlFor="add-section-label"
        error={error}
      >
        <textarea
          id="add-section-label"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
            setError(null);
          }}
          rows={2}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={submit}>
          {busy ? "Adding…" : "Add section"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function SectionRenameForm({
  currentName,
  template,
  busy,
  onCancel,
  onSave,
}: {
  currentName: string;
  template: OpeningChecklistTemplateConfigResponse;
  busy: boolean;
  onCancel: () => void;
  onSave: (to: string) => void;
}) {
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const result = validateChecklistSectionName(name);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const existing = matchesExistingSection(template, result.value);
    if (existing && existing !== currentName) {
      setError(`“${existing}” already exists. Pick a different name.`);
      return;
    }
    onSave(result.value);
  }

  return (
    <Card tone="subtle" className="flex flex-col gap-3">
      <FormField label="Section name" htmlFor="rename-section" error={error}>
        <input
          id="rename-section"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          autoComplete="off"
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
        />
      </FormField>
      <p className="text-xs text-text-muted">
        Renames this section for the corporate checklist only. Checklists
        already created keep their original section names.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={submit}>
          {busy ? "Saving…" : "Save name"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
