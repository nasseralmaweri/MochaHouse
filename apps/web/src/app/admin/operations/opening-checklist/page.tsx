"use client";

import { useCallback, useEffect, useState } from "react";
import type { OpeningChecklistResponse } from "@mocha-house/contracts";
import {
  completeOpeningChecklistItemFromBrowser,
  getOpeningChecklistFromBrowser,
  undoOpeningChecklistItemFromBrowser,
  type OpeningChecklistResult,
} from "@/lib/api-client";
import {
  buildOpeningChecklistViewModel,
  nextChecklistLoadState,
  resolveOpeningChecklistPage,
  type OpeningChecklistItemViewModel,
} from "@/lib/admin/opening-checklist";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
  AdminLoading,
} from "@/components/admin/states";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/Card";
import { useAdminContext } from "@/components/admin/AdminContext";

// Admin → Operations → Today → Opening Checklist (Milestone 6B). A
// store-use workflow: open today's checklist, complete items with one tap,
// see progress, undo an accidental completion. `operations.view` gates the
// page; the Complete / Undo controls need `operations.tasks.complete` for
// THIS location — a viewer without it sees the checklist read-only.
//
// The server (GET) lazily creates today's instance and snapshots the
// active template items. Complete / Undo return the full authoritative
// projection; the UI always reconciles from it.
export default function OpeningChecklistPage() {
  const { can, canAtLocation, capabilities, locationContext } =
    useAdminContext();

  const header = <AdminPageHeader title="Opening Checklist" />;

  if (!can("operations.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const page = resolveOpeningChecklistPage({ locationContext, capabilities });

  if (page.kind === "forbidden-location") {
    return (
      <AdminPage>
        {header}
        <AdminForbidden
          title="You're not assigned to that location"
          description="The location in this link isn't in your assigned scope. Pick one of your locations from the selector above."
        />
      </AdminPage>
    );
  }

  if (page.kind === "no-location") {
    return (
      <AdminPage>
        {header}
        <AdminEmptyState
          title="No location assigned"
          description="You don't have any locations in your scope yet. An administrator needs to assign one."
        />
      </AdminPage>
    );
  }

  if (page.kind === "pick-location") {
    return (
      <AdminPage>
        <AdminPageHeader
          title="Opening Checklist"
          context={{ label: "All locations", kind: "corporate" }}
        />
        <AdminEmptyState
          title="Select a location"
          description="The opening checklist is per store. Choose one from the selector in the top bar."
        />
      </AdminPage>
    );
  }

  // `operations.view` is held somewhere, but the resolved location comes
  // from the general operational-scope set — it may not be a location the
  // viewer holds `operations.view` FOR.
  if (!canAtLocation("operations.view", page.locationId)) {
    return (
      <AdminPage>
        <AdminPageHeader
          title="Opening Checklist"
          context={{ label: page.locationName, kind: "location" }}
        />
        <AdminForbidden
          title="Not in your scope for operations"
          description="You can view operations at some locations, but not this one. Switch to one of your locations from the selector above."
        />
      </AdminPage>
    );
  }

  return (
    <OpeningChecklist
      key={page.locationId}
      locationId={page.locationId}
      canComplete={page.canComplete}
    />
  );
}

function OpeningChecklist({
  locationId,
  canComplete,
}: {
  locationId: string;
  canComplete: boolean;
}) {
  const [checklist, setChecklist] = useState<OpeningChecklistResponse | null>(
    null,
  );
  const [state, setState] = useState<"ok" | "forbidden" | "error">("ok");
  const [notice, setNotice] = useState<string | null>(null);
  // Item ids with a Complete/Undo request in flight — drives the disabled
  // state and prevents a double submission.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const applyResult = useCallback((result: OpeningChecklistResult): boolean => {
    if (result.outcome === "success") {
      setState("ok");
      setNotice(null);
      setChecklist(result.checklist);
      return true;
    }
    // Every non-success outcome lands on a definite state — a failed load
    // must reach the retryable AdminErrorState below, never leave the page
    // on its loading skeleton (see `state === "error" && !checklist`).
    setState(nextChecklistLoadState(result.outcome));
    if (result.outcome === "not-found") {
      // The instance/item moved under us (e.g. the business day rolled
      // over). A mutation caller re-loads; the initial load falls back to
      // the error state above.
      setNotice("This checklist has changed. Refreshing…");
    } else if (result.outcome === "error") {
      setNotice(result.message);
    }
    return false;
  }, []);

  const load = useCallback(async () => {
    applyResult(await getOpeningChecklistFromBrowser(locationId));
  }, [applyResult, locationId]);

  useEffect(() => {
    let cancelled = false;
    getOpeningChecklistFromBrowser(locationId).then((result) => {
      if (cancelled) return;
      applyResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [applyResult, locationId]);

  async function mutate(
    item: OpeningChecklistItemViewModel,
    action: "complete" | "undo",
  ) {
    if (pending.has(item.id)) return;
    setPending((current) => new Set(current).add(item.id));
    try {
      const result =
        action === "complete"
          ? await completeOpeningChecklistItemFromBrowser(item.id, locationId)
          : await undoOpeningChecklistItemFromBrowser(item.id, locationId);
      const ok = applyResult(result);
      if (!ok && result.outcome === "not-found") {
        await load();
      }
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  }

  if (state === "forbidden") {
    return (
      <AdminPage>
        <AdminPageHeader title="Opening Checklist" />
        <AdminForbidden />
      </AdminPage>
    );
  }

  if (state === "error" && !checklist) {
    return (
      <AdminPage>
        <AdminPageHeader title="Opening Checklist" />
        <AdminErrorState
          description="Couldn't load the opening checklist for this location."
          onRetry={() => void load()}
        />
      </AdminPage>
    );
  }

  if (!checklist) {
    return (
      <AdminPage>
        <AdminPageHeader title="Opening Checklist" />
        <AdminLoading label="Loading the opening checklist" />
      </AdminPage>
    );
  }

  const vm = buildOpeningChecklistViewModel(checklist, { canComplete });

  return (
    <AdminPage>
      <AdminPageHeader
        title={vm.title}
        description={`Business day: ${vm.businessDate}`}
        context={{ label: vm.locationName, kind: "location" }}
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        }
      />

      <Card tone="subtle" className="flex flex-col gap-1">
        <span className="text-sm font-medium text-text-primary">
          {vm.progressLabel}
        </span>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-surface-card"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={vm.progress.total}
          aria-valuenow={vm.progress.completed}
        >
          <div
            className="h-full rounded-full bg-status-success transition-[width]"
            style={{
              width: `${
                vm.progress.total === 0
                  ? 0
                  : Math.round(
                      (vm.progress.completed / vm.progress.total) * 100,
                    )
              }%`,
            }}
          />
        </div>
      </Card>

      {vm.isComplete ? (
        <Card className="border-status-success/40 bg-status-success/5 text-sm font-medium text-status-success">
          Opening checklist complete
        </Card>
      ) : null}

      {vm.readOnly ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          You can view the opening checklist for this location, but completing
          items needs the operational tasks permission. Ask an administrator if
          you need it.
        </Card>
      ) : null}

      {notice ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          {notice}
        </Card>
      ) : null}

      {vm.sections.map((section) => (
        <AdminSection key={section.name} title={section.name}>
          <ul className="flex flex-col gap-2">
            {section.items.map((item) => (
              <li key={item.id}>
                <ChecklistItemRow
                  item={item}
                  busy={pending.has(item.id)}
                  onComplete={() => void mutate(item, "complete")}
                  onUndo={() => void mutate(item, "undo")}
                />
              </li>
            ))}
          </ul>
        </AdminSection>
      ))}
    </AdminPage>
  );
}

function ChecklistItemRow({
  item,
  busy,
  onComplete,
  onUndo,
}: {
  item: OpeningChecklistItemViewModel;
  busy: boolean;
  onComplete: () => void;
  onUndo: () => void;
}) {
  return (
    <Card
      className={`flex flex-col gap-3 ${
        item.completed ? "border-status-success/40 bg-status-success/5" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={`mt-0.5 text-base ${
            item.completed ? "text-status-success" : "text-text-muted"
          }`}
        >
          {item.completed ? "✓" : "○"}
        </span>
        <p className="text-sm text-text-primary">{item.label}</p>
      </div>

      {item.completed ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs text-text-secondary">
            {item.completedByName
              ? `Completed by ${item.completedByName}`
              : "Completed"}
            {item.completedAt
              ? ` · ${new Date(item.completedAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}`
              : ""}
          </span>
          {item.showUndo ? (
            <Button
              variant="secondary"
              className="w-full sm:w-auto"
              onClick={onUndo}
              disabled={busy}
            >
              {busy ? "Working…" : "Undo"}
            </Button>
          ) : null}
        </div>
      ) : item.showComplete ? (
        <Button
          className="w-full sm:w-auto sm:self-start"
          onClick={onComplete}
          disabled={busy}
        >
          {busy ? "Working…" : "Complete"}
        </Button>
      ) : (
        <span className="text-xs text-text-muted">Not yet complete</span>
      )}
    </Card>
  );
}
