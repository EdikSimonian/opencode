import { expect } from "bun:test"
import { Effect, Ref } from "effect"
import { testEffect } from "../lib/effect"
import { WorkflowStore } from "@/workflow/store"

const t = testEffect(WorkflowStore.layer)

t.instance("tracks run and step lifecycle from events", () =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore.Service
    const emit = store.sink("wf_1", { title: "demo" })
    yield* emit({ type: "run.started", runID: "wf_1", at: 1 })
    yield* emit({
      type: "step.started",
      runID: "wf_1",
      stepID: "s1",
      nodeID: "a",
      label: "a",
      agentType: "general",
      phase: "Build",
      at: 2,
    })

    let info = yield* store.get("wf_1")
    expect(info?.status).toBe("running")
    expect(info?.title).toBe("demo")
    expect(info?.steps).toHaveLength(1)
    expect(info?.steps[0]?.status).toBe("running")
    expect(info?.steps[0]?.phase).toBe("Build")

    yield* emit({ type: "step.finished", runID: "wf_1", stepID: "s1", status: "completed", at: 3 })
    yield* emit({ type: "run.finished", runID: "wf_1", status: "completed", at: 4 })

    info = yield* store.get("wf_1")
    expect(info?.status).toBe("completed")
    expect(info?.completed_at).toBe(4)
    expect(info?.steps[0]?.status).toBe("completed")
    expect(info?.steps[0]?.completed_at).toBe(3)
  }),
)

t.instance("records step errors", () =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore.Service
    const emit = store.sink("wf_err")
    yield* emit({ type: "run.started", runID: "wf_err", at: 1 })
    yield* emit({ type: "step.started", runID: "wf_err", stepID: "s1", nodeID: "a", label: "a", agentType: "x", at: 2 })
    yield* emit({ type: "step.finished", runID: "wf_err", stepID: "s1", status: "error", at: 3, error: "boom" })
    yield* emit({ type: "run.finished", runID: "wf_err", status: "error", at: 4, error: "boom" })
    const info = yield* store.get("wf_err")
    expect(info?.status).toBe("error")
    expect(info?.error).toBe("boom")
    expect(info?.steps[0]?.error).toBe("boom")
  }),
)

t.instance("cancel invokes the registered canceller", () =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore.Service
    const emit = store.sink("wf_2")
    yield* emit({ type: "run.started", runID: "wf_2", at: 1 })
    const flag = yield* Ref.make(false)
    yield* store.setCancel("wf_2", Ref.set(flag, true))
    yield* store.cancel("wf_2")
    expect(yield* Ref.get(flag)).toBe(true)
  }),
)

t.instance("cancel is a no-op for finished or unknown runs", () =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore.Service
    expect(yield* store.cancel("missing")).toBeUndefined()

    const emit = store.sink("wf_done")
    yield* emit({ type: "run.started", runID: "wf_done", at: 1 })
    yield* emit({ type: "run.finished", runID: "wf_done", status: "completed", at: 2 })
    const flag = yield* Ref.make(false)
    yield* store.setCancel("wf_done", Ref.set(flag, true))
    const info = yield* store.cancel("wf_done")
    expect(info?.status).toBe("completed")
    expect(yield* Ref.get(flag)).toBe(false)
  }),
)

t.instance("list returns runs sorted by start time", () =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore.Service
    yield* store.sink("wf_b")({ type: "run.started", runID: "wf_b", at: 20 })
    yield* store.sink("wf_a")({ type: "run.started", runID: "wf_a", at: 10 })
    const all = yield* store.list()
    expect(all.map((r) => r.runID)).toEqual(["wf_a", "wf_b"])
  }),
)
