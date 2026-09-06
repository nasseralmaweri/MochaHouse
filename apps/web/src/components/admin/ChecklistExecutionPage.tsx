"use client";

import { useCallback, useEffect, useState } from "react";
import type { OpeningChecklistResponse } from "@mocha-house/contracts";
import {
  clearChecklistExceptionFromBrowser,
  completeChecklistItemFromBrowser,
  getChecklistFromBrowser,
  logChecklistExceptionFromBrowser,
  undoChecklistItemFromBrowser,
  type ChecklistKind,
  type ChecklistResult,
} from "@/lib/api-client";
import {
  buildChecklistViewModel,
  nextChecklistLoadState,
  resolveChecklistPage,
  type ChecklistItemViewModel,
} from "@/lib/admin/checklist-execution";
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
import { ADMIN_FIELD_CLASS, FormField } from "@/components/admin/form";
import { useAdminContext } from "@/components/admin/AdminContext";

// Shared execution page for the daily checklists (Milestone 6B Opening; 6C
// management exception; 6D Closing). A store-use workflow: open today's
// checklist, complete items with one tap, undo an accidental completion.
// When a requirement genuinely could not be met, an authorized manager
// (operations.exceptions.manage) can Log a management exception with a
// reason — the item is RESOLVED but is never shown as an ordinary
// completed checkmark. `operations.view` gates the page.
//
// Identical for Opening and Closing — only the route family and the visible
// name differ (`checklist` prop). The server (GET) lazily creates today's
// instance; every mutation returns the full authoritative projection.

const TITLE: Record<ChecklistKind, string> = {
  opening: "Opening Checklist",
  closing: "Closing Checklist",
};

export function ChecklistExecutionPage({
  checklist,
}: {
  checklist: ChecklistKind;
}) {
  const { can, canAtLocation, capabilities, locationContext } =
    useAdminContext();

  const title = TITLE[checklist];
  const header = <AdminPageHeader title={title} />;

  if (!can("operations.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const page = resolveChecklistPage({ locationContext, capabilities });

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
          title={title}
          context={{ label: "All locations", kind: "corporate" }}
        />
        <AdminEmptyState
          title="Select a location"
          description="This checklist is per store. Choose one from the selector in the top bar."
        />
      </AdminPage>
    );
  }

  if (!canAtLocation("operations.view", page.locationId)) {
    return (
      <AdminPage>
        <AdminPageHeader
          title={title}
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
    <Checklist
      key={`${checklist}:${page.locationId}`}
      checklist={checklist}
      title={title}
      locationId={page.locationId}
      canComplete={page.canComplete}
      canLogExceptions={page.canLogExceptions}
    />
  );
}

type ItemAction =
  | { kind: "complete" | "undo" | "clear-exception" }
  | { kind: "log-exception"; reason: string };

function Checklist({
  checklist,
  title,
  locationId,
  canComplete,
  canLogExceptions,
}: {
  checklist: ChecklistKind;
  title: string;
  locationId: string;
  canComplete: boolean;
  canLogExceptions: boolean;
}) {
  const [data, setData] = useState<OpeningChecklistResponse | null>(null);
  const [state, setState] = useState<"ok" | "forbidden" | "error">("ok");
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [exceptionDraftFor, setExceptionDraftFor] = useState<string | null>(
    null,
  );

  const applyResult = useCallback((result: ChecklistResult): boolean => {
    if (result.outcome === "success") {
      setState("ok");
      setNotice(null);
      setData(result.checklist);
      return true;
    }
    // A failed load must reach the retryable AdminErrorState below; a
    // rejected mutation ("invalid") keeps the loaded checklist and shows
    // its message inline.
    setState(nextChecklistLoadState(result.outcome));
    if (result.outcome === "not-found") {
      setNotice("This checklist has changed. Refreshing…");
    } else if (result.outcome === "invalid" || result.outcome === "error") {
      setNotice(result.message);
    }
    return false;
  }, []);

  const load = useCallback(async () => {
    applyResult(await getChecklistFromBrowser(checklist, locationId));
  }, [applyResult, checklist, locationId]);

  useEffect(() => {
    let cancelled = false;
    getChecklistFromBrowser(checklist, locationId).then((result) => {
      if (!cancelled) applyResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [applyResult, checklist, locationId]);

  async function mutate(item: ChecklistItemViewModel, action: ItemAction) {
    if (pending.has(item.id)) return;
    setPending((current) => new Set(current).add(item.id));
    try {
      let result: ChecklistResult;
      switch (action.kind) {
        case "complete":
          result = await completeChecklistItemFromBrowser(
            checklist,
            item.id,
            locationId,
          );
          break;
        case "undo":
          result = await undoChecklistItemFromBrowser(
            checklist,
            item.id,
            locationId,
          );
          break;
        case "log-exception":
          result = await logChecklistExceptionFromBrowser(
            checklist,
            item.id,
            locationId,
            action.reason,
          );
          break;
        case "clear-exception":
          result = await clearChecklistExceptionFromBrowser(
            checklist,
            item.id,
            locationId,
          );
          break;
      }
      const ok = applyResult(result);
      if (
        ok &&
        (action.kind === "log-exception" || action.kind === "clear-exception")
      ) {
        setExceptionDraftFor(null);
      }
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
        <AdminPageHeader title={title} />
        <AdminForbidden />
      </AdminPage>
    );
  }

  if (state === "error" && !data) {
    return (
      <AdminPage>
        <AdminPageHeader title={title} />
        <AdminErrorState
          description={`Couldn't load the ${title.toLowerCase()} for this location.`}
          onRetry={() => void load()}
        />
      </AdminPage>
    );
  }

  if (!data) {
    return (
      <AdminPage>
        <AdminPageHeader title={title} />
        <AdminLoading label={`Loading the ${title.toLowerCase()}`} />
      </AdminPage>
    );
  }

  const vm = buildChecklistViewModel(data, { canComplete, canLogExceptions });
  const pct =
    vm.progress.total === 0
      ? 0
      : Math.round((vm.progress.resolved / vm.progress.total) * 100);

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
          aria-valuenow={vm.progress.resolved}
        >
          <div
            className="h-full rounded-full bg-status-success transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
      </Card>

      {vm.isComplete ? (
        <Card className="border-status-success/40 bg-status-success/5 text-sm font-medium text-status-success">
          {vm.title} complete
        </Card>
      ) : null}

      {vm.readOnly ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          You can view this checklist for this location, but acting on items
          needs the operational tasks or exception permission. Ask an
          administrator if you need it.
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
                  draftingException={exceptionDraftFor === item.id}
                  onComplete={() => void mutate(item, { kind: "complete" })}
                  onUndo={() => void mutate(item, { kind: "undo" })}
                  onStartException={() => setExceptionDraftFor(item.id)}
                  onCancelException={() => setExceptionDraftFor(null)}
                  onLogException={(reason) =>
                    void mutate(item, { kind: "log-exception", reason })
                  }
                  onClearException={() =>
                    void mutate(item, { kind: "clear-exception" })
                  }
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
  draftingException,
  onComplete,
  onUndo,
  onStartException,
  onCancelException,
  onLogException,
  onClearException,
}: {
  item: ChecklistItemViewModel;
  busy: boolean;
  draftingException: boolean;
  onComplete: () => void;
  onUndo: () => void;
  onStartException: () => void;
  onCancelException: () => void;
  onLogException: (reason: string) => void;
  onClearException: () => void;
}) {
  const marker =
    item.status === "completed" ? "✓" : item.status === "exception" ? "!" : "○";
  const markerClass =
    item.status === "completed"
      ? "text-status-success"
      : item.status === "exception"
        ? "text-status-warning"
        : "text-text-muted";
  const cardAccent =
    item.status === "completed"
      ? "border-status-success/40 bg-status-success/5"
      : item.status === "exception"
        ? "border-status-warning/40 bg-status-warning/5"
        : "";

  return (
    <Card className={`flex flex-col gap-3 ${cardAccent}`}>
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className={`mt-0.5 text-base ${markerClass}`}>
          {marker}
        </span>
        <p className="text-sm text-text-primary">{item.label}</p>
      </div>

      {item.status === "completed" ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs text-text-secondary">
            {item.completedByName
              ? `Completed by ${item.completedByName}`
              : "Completed"}
            {item.completedAt ? ` · ${formatTime(item.completedAt)}` : ""}
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
      ) : item.status === "exception" && item.exception ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-status-warning">
            Management exception
          </span>
          <p className="text-sm text-text-primary">
            &ldquo;{item.exception.reason}&rdquo;
          </p>
          <span className="text-xs text-text-secondary">
            {item.exception.byName
              ? `Logged by ${item.exception.byName}`
              : "Logged"}
            {item.exception.at ? ` · ${formatTime(item.exception.at)}` : ""}
          </span>
          {item.showClearException ? (
            <div>
              <Button
                variant="secondary"
                className="w-full sm:w-auto"
                onClick={onClearException}
                disabled={busy}
              >
                {busy ? "Working…" : "Clear exception"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : draftingException ? (
        <ExceptionReasonForm
          busy={busy}
          onCancel={onCancelException}
          onSubmit={onLogException}
        />
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {item.showComplete ? (
            <Button
              className="w-full sm:w-auto"
              onClick={onComplete}
              disabled={busy}
            >
              {busy ? "Working…" : "Complete"}
            </Button>
          ) : null}
          {item.showLogException ? (
            <Button
              variant="secondary"
              className="w-full sm:w-auto"
              onClick={onStartException}
              disabled={busy}
            >
              Log exception
            </Button>
          ) : null}
          {!item.showComplete && !item.showLogException ? (
            <span className="text-xs text-text-muted">Not yet complete</span>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function ExceptionReasonForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setError("Enter a reason for the exception.");
      return;
    }
    if (trimmed.length > 500) {
      setError("Keep the reason under 500 characters.");
      return;
    }
    onSubmit(trimmed);
  }

  return (
    <div className="flex flex-col gap-2">
      <FormField
        label="Reason for the exception"
        htmlFor="exception-reason"
        hint="Why this requirement could not be completed. Recorded for management."
        error={error}
      >
        <textarea
          id="exception-reason"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setError(null);
          }}
          rows={2}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={submit}>
          {busy ? "Working…" : "Log exception"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
