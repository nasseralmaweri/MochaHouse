import type { OperationsTasksResponse } from "@mocha-house/contracts";

// Framework-free view-model for the Today's Tasks section on Operations
// Today (Milestone 6C). No authorization decision of its own — the API
// guards every call (`operations.view` to read, `operations.tasks.complete`
// to write). This only shapes what the section renders.

export type TasksLoadOutcome =
  | "success"
  | "forbidden"
  | "not-found"
  | "invalid"
  | "error";

export type TasksLoadState = "ok" | "forbidden" | "error";

// A failed INITIAL load must reach the retryable error card. A rejected
// mutation ("invalid") keeps the loaded list and shows its message inline.
export function nextTasksLoadState(outcome: TasksLoadOutcome): TasksLoadState {
  switch (outcome) {
    case "success":
    case "invalid":
      return "ok";
    case "forbidden":
      return "forbidden";
    case "not-found":
    case "error":
      return "error";
  }
}

export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_NOTE_MAX_LENGTH = 500;

export type FieldResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function validateTaskTitle(raw: string): FieldResult {
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, error: "Enter a task." };
  }
  if (value.length > TASK_TITLE_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep the task under ${TASK_TITLE_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, value };
}

export function validateTaskNote(raw: string): FieldResult {
  const value = raw.trim();
  if (value.length > TASK_NOTE_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep the note under ${TASK_NOTE_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, value };
}

export interface TaskViewModel {
  id: string;
  title: string;
  note: string | null;
  done: boolean;
  completedByName: string | null;
  completedAt: string | null;
  createdByName: string | null;
  // Exactly one of these is offered, gated by `canManage`.
  showComplete: boolean;
  showReopen: boolean;
  showDelete: boolean;
}

export interface TasksViewModel {
  businessDate: string;
  locationName: string;
  openCount: number;
  doneCount: number;
  total: number;
  // A concise summary line, e.g. "2 open · 1 done" or "No tasks yet".
  summary: string;
  canManage: boolean;
  tasks: TaskViewModel[];
}

export function buildTasksViewModel(
  response: OperationsTasksResponse,
  options: { canManage: boolean },
): TasksViewModel {
  const { canManage } = options;
  const total = response.tasks.length;

  return {
    businessDate: response.businessDate,
    locationName: response.locationName,
    openCount: response.openCount,
    doneCount: response.doneCount,
    total,
    summary:
      total === 0
        ? "No tasks yet"
        : `${response.openCount} open · ${response.doneCount} done`,
    canManage,
    tasks: response.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      note: task.note,
      done: task.done,
      completedByName: task.completedBy?.name ?? null,
      completedAt: task.completedAt,
      createdByName: task.createdBy?.name ?? null,
      showComplete: canManage && !task.done,
      showReopen: canManage && task.done,
      showDelete: canManage,
    })),
  };
}
