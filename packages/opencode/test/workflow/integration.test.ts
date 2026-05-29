import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { WorkflowStore } from "@/workflow/store"
import { interpret } from "@/workflow/interpreter"
import { makeFakeRunner } from "@/workflow/runner"
import type { IR } from "@/workflow/ir"

const t = testEffect(WorkflowStore.layer)

const agent = (id: string): IR => ({ kind: "agent", id, agentType: "general", prompt: `p:${id}` })

// Exercises the integration the workflow_status tool depends on: interpreter
// events feed the store live, and cancelling via the store interrupts the
// running fiber, which the interpreter reflects back as cancelled status.
t.instance("store tracks a live run and cancels it through the registered canceller", () =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore.Service
    const runner = yield* makeFakeRunner({ default: { delayMillis: 10_000 } })
    const runID = "wf_integration"
    const emit = store.sink(runID, { title: "integration" })

    const node: IR = { kind: "parallel", children: [agent("a"), agent("b")] }
    const fiber = yield* Effect.forkScoped(interpret({ runID, node, runner, emit, concurrency: 4 }))
    yield* store.setCancel(runID, Fiber.interrupt(fiber).pipe(Effect.asVoid))

    // Wait until the store shows both steps actually running.
    const running = yield* pollWithTimeout(
      Effect.gen(function* () {
        const info = yield* store.get(runID)
        return info && info.steps.length === 2 && info.steps.every((s) => s.status === "running") ? info : undefined
      }),
      "steps never reached running state",
    )
    expect(running.status).toBe("running")

    // Cancel through the store (as the status tool would) and let teardown settle.
    yield* store.cancel(runID)
    yield* Fiber.await(fiber)

    const info = yield* store.get(runID)
    expect(info?.status).toBe("cancelled")
    expect(info?.steps).toHaveLength(2)
    expect(info?.steps.every((s) => s.status === "cancelled")).toBe(true)
  }),
)
