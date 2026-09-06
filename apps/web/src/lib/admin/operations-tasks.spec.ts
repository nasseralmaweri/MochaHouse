import type { OperationsTasksResponse } from "@mocha-house/contracts";
import {
  buildTasksViewModel,
  nextTasksLoadState,
  validateTaskNote,
  validateTaskTitle,
} from "./operations-tasks";

function response(
  overrides: Partial<OperationsTasksResponse> = {},
): OperationsTasksResponse {
  return {
    locationId: "loc-a",
    locationName: "Mocha House - Dearborn Heights",
    businessDate: "2026-09-06",
    openCount: 1,
    doneCount: 1,
    tasks: [
      {
        id: "t1",
        title: "Restock pastries",
        note: "extra croissants",
        done: false,
        completedBy: null,
        completedAt: null,
        createdBy: { name: "Sam" },
        createdAt: "2026-09-06T11:00:00.000Z",
      },
      {
        id: "t2",
        title: "Wipe the syrup station",
        note: null,
        done: true,
        completedBy: { name: "Dana" },
        completedAt: "2026-09-06T11:30:00.000Z",
        createdBy: { name: "Sam" },
        createdAt: "2026-09-06T10:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("buildTasksViewModel", () => {
  it("keeps the API order and counts, and summarises", () => {
    const vm = buildTasksViewModel(response(), { canManage: true });
    expect(vm.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(vm.openCount).toBe(1);
    expect(vm.doneCount).toBe(1);
    expect(vm.total).toBe(2);
    expect(vm.summary).toBe("1 open · 1 done");
  });

  it("empty state", () => {
    const vm = buildTasksViewModel(
      response({ tasks: [], openCount: 0, doneCount: 0 }),
      { canManage: true },
    );
    expect(vm.total).toBe(0);
    expect(vm.summary).toBe("No tasks yet");
  });

  it("a manager gets Complete on open tasks, Reopen on done tasks, Delete on all", () => {
    const vm = buildTasksViewModel(response(), { canManage: true });
    expect(vm.tasks.find((t) => t.id === "t1")).toMatchObject({
      done: false,
      showComplete: true,
      showReopen: false,
      showDelete: true,
    });
    expect(vm.tasks.find((t) => t.id === "t2")).toMatchObject({
      done: true,
      showComplete: false,
      showReopen: true,
      showDelete: true,
      completedByName: "Dana",
    });
  });

  it("a read-only viewer gets no controls but still sees the tasks", () => {
    const vm = buildTasksViewModel(response(), { canManage: false });
    for (const t of vm.tasks) {
      expect(t.showComplete).toBe(false);
      expect(t.showReopen).toBe(false);
      expect(t.showDelete).toBe(false);
    }
    expect(vm.tasks[0].createdByName).toBe("Sam");
  });
});

describe("nextTasksLoadState", () => {
  it("maps outcomes", () => {
    expect(nextTasksLoadState("success")).toBe("ok");
    expect(nextTasksLoadState("invalid")).toBe("ok");
    expect(nextTasksLoadState("forbidden")).toBe("forbidden");
    expect(nextTasksLoadState("not-found")).toBe("error");
    expect(nextTasksLoadState("error")).toBe("error");
  });
});

describe("task validation", () => {
  it("title required, trimmed, capped", () => {
    expect(validateTaskTitle("   ")).toEqual({ ok: false, error: "Enter a task." });
    expect(validateTaskTitle("x".repeat(201)).ok).toBe(false);
    expect(validateTaskTitle("  Do it  ")).toEqual({ ok: true, value: "Do it" });
  });

  it("note optional, trimmed, capped", () => {
    expect(validateTaskNote("")).toEqual({ ok: true, value: "" });
    expect(validateTaskNote("y".repeat(501)).ok).toBe(false);
    expect(validateTaskNote("  hi  ")).toEqual({ ok: true, value: "hi" });
  });
});
