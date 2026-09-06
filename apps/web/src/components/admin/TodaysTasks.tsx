"use client";

import { useCallback, useEffect, useState } from "react";
import type { OperationsTasksResponse } from "@mocha-house/contracts";
import {
  actOnOperationsTaskFromBrowser,
  createOperationsTaskFromBrowser,
  getOperationsTasksFromBrowser,
  type OperationsTasksResult,
} from "@/lib/api-client";
import {
  buildTasksViewModel,
  nextTasksLoadState,
  validateTaskNote,
  validateTaskTitle,
  type TaskViewModel,
  type TasksLoadState,
} from "@/lib/admin/operations-tasks";
import { AdminErrorState, AdminLoading } from "@/components/admin/states";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/Card";
import { ADMIN_FIELD_CLASS, FormField } from "@/components/admin/form";

// Today's Tasks, inline on Operations Today (Milestone 6C). Simple
// location-scoped to-dos for the current business date. The API is the
// authority: `operations.view` reads, `operations.tasks.complete` writes,
// and every mutation returns the whole list to reconcile from.
export function TodaysTasks({
  locationId,
  canManage,
}: {
  locationId: string;
  canManage: boolean;
}) {
  const [tasks, setTasks] = useState<OperationsTasksResponse | null>(null);
  const [state, setState] = useState<TasksLoadState>("ok");
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const applyResult = useCallback((result: OperationsTasksResult): boolean => {
    if (result.outcome === "success") {
      setState("ok");
      setNotice(null);
      setTasks(result.tasks);
      return true;
    }
    setState(nextTasksLoadState(result.outcome));
    if (result.outcome === "not-found") {
      setNotice("This list has changed. Refreshing…");
    } else if (result.outcome === "invalid" || result.outcome === "error") {
      setNotice(result.message);
    }
    return false;
  }, []);

  const load = useCallback(async () => {
    applyResult(await getOperationsTasksFromBrowser(locationId));
  }, [applyResult, locationId]);

  useEffect(() => {
    let cancelled = false;
    getOperationsTasksFromBrowser(locationId).then((result) => {
      if (!cancelled) applyResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [applyResult, locationId]);

  const run = useCallback(
    async (
      key: string,
      action: () => Promise<OperationsTasksResult>,
      onDone?: () => void,
    ) => {
      if (pending.has(key)) return;
      setPending((current) => new Set(current).add(key));
      setNotice(null);
      try {
        const result = await action();
        const ok = applyResult(result);
        if (ok) onDone?.();
        else if (result.outcome === "not-found") await load();
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [applyResult, load, pending],
  );

  if (state === "forbidden") {
    // operations.view gates the whole page, so this is unexpected — treat
    // it as a transient error rather than hiding the section.
    return (
      <AdminErrorState
        description="Couldn't load today's tasks for this location."
        onRetry={() => void load()}
      />
    );
  }
  if (state === "error" && !tasks) {
    return (
      <AdminErrorState
        description="Couldn't load today's tasks for this location."
        onRetry={() => void load()}
      />
    );
  }
  if (!tasks) {
    return <AdminLoading label="Loading today's tasks" />;
  }

  const vm = buildTasksViewModel(tasks, { canManage });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-muted">{vm.summary}</p>

      {notice ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          {notice}
        </Card>
      ) : null}

      {vm.tasks.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {vm.tasks.map((task) => (
            <li key={task.id}>
              <TaskRow
                task={task}
                busy={pending.has(task.id)}
                onComplete={() =>
                  void run(task.id, () =>
                    actOnOperationsTaskFromBrowser(task.id, locationId, "complete"),
                  )
                }
                onReopen={() =>
                  void run(task.id, () =>
                    actOnOperationsTaskFromBrowser(task.id, locationId, "reopen"),
                  )
                }
                onDelete={() =>
                  void run(task.id, () =>
                    actOnOperationsTaskFromBrowser(task.id, locationId, "delete"),
                  )
                }
              />
            </li>
          ))}
        </ul>
      ) : null}

      {canManage ? (
        adding ? (
          <AddTaskForm
            busy={pending.has("add")}
            onCancel={() => setAdding(false)}
            onAdd={(title, note) =>
              void run(
                "add",
                () =>
                  createOperationsTaskFromBrowser({
                    locationId,
                    title,
                    ...(note ? { note } : {}),
                  }),
                () => setAdding(false),
              )
            }
          />
        ) : (
          <div>
            <Button variant="secondary" onClick={() => setAdding(true)}>
              + Add a task
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

function TaskRow({
  task,
  busy,
  onComplete,
  onReopen,
  onDelete,
}: {
  task: TaskViewModel;
  busy: boolean;
  onComplete: () => void;
  onReopen: () => void;
  onDelete: () => void;
}) {
  return (
    <Card
      className={`flex flex-col gap-2 ${
        task.done ? "border-status-success/40 bg-status-success/5" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={`mt-0.5 text-base ${
            task.done ? "text-status-success" : "text-text-muted"
          }`}
        >
          {task.done ? "✓" : "○"}
        </span>
        <div className="flex flex-col gap-0.5">
          <p className="text-sm text-text-primary">{task.title}</p>
          {task.note ? (
            <p className="text-xs text-text-secondary">{task.note}</p>
          ) : null}
          <p className="text-xs text-text-muted">
            {task.done
              ? `Done${task.completedByName ? ` by ${task.completedByName}` : ""}`
              : task.createdByName
                ? `Added by ${task.createdByName}`
                : "Added"}
          </p>
        </div>
      </div>

      {task.showComplete || task.showReopen || task.showDelete ? (
        <div className="flex flex-wrap gap-2">
          {task.showComplete ? (
            <Button onClick={onComplete} disabled={busy}>
              {busy ? "Working…" : "Complete"}
            </Button>
          ) : null}
          {task.showReopen ? (
            <Button variant="secondary" onClick={onReopen} disabled={busy}>
              {busy ? "Working…" : "Reopen"}
            </Button>
          ) : null}
          {task.showDelete ? (
            <Button variant="secondary" onClick={onDelete} disabled={busy}>
              Delete
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function AddTaskForm({
  busy,
  onCancel,
  onAdd,
}: {
  busy: boolean;
  onCancel: () => void;
  onAdd: (title: string, note: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const titleResult = validateTaskTitle(title);
    if (!titleResult.ok) {
      setError(titleResult.error);
      return;
    }
    const noteResult = validateTaskNote(note);
    if (!noteResult.ok) {
      setError(noteResult.error);
      return;
    }
    onAdd(titleResult.value, noteResult.value);
  }

  return (
    <Card tone="subtle" className="flex flex-col gap-3">
      <FormField label="Task" htmlFor="task-title" error={error}>
        <input
          id="task-title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setError(null);
          }}
          autoComplete="off"
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
        />
      </FormField>
      <FormField label="Note" htmlFor="task-note" hint="Optional.">
        <textarea
          id="task-note"
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
            setError(null);
          }}
          rows={2}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={submit}>
          {busy ? "Adding…" : "Add task"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
