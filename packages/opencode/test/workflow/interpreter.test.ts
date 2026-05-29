import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Ref } from "effect"
import { it } from "../lib/effect"
import { interpret } from "@/workflow/interpreter"
import { makeFakeRunner } from "@/workflow/runner"
import type { Event } from "@/workflow/events"
import type { IR } from "@/workflow/ir"

const makeCollector = Effect.gen(function* () {
  const ref = yield* Ref.make<Event[]>([])
  return {
    emit: (event: Event) => Ref.update(ref, (xs) => [...xs, event]),
    events: () => Ref.get(ref),
  }
})

const agent = (id: string, extra: Partial<IR & { kind: "agent" }> = {}): IR => ({
  kind: "agent",
  id,
  agentType: "general",
  prompt: `prompt:${id}`,
  ...extra,
})

const types = (events: Event[]) => events.map((e) => e.type)
const finished = (events: Event[]) => events.filter((e): e is Extract<Event, { type: "step.finished" }> => e.type === "step.finished")
const runFinished = (events: Event[]) => events.find((e): e is Extract<Event, { type: "run.finished" }> => e.type === "run.finished")

describe("workflow interpreter", () => {
  it.live("runs a single agent step and emits the lifecycle", () =>
    Effect.gen(function* () {
      const runner = yield* makeFakeRunner({ default: { text: "hello" } })
      const col = yield* makeCollector
      const results = yield* interpret({ runID: "wf_one", node: agent("a"), runner, emit: col.emit })
      expect(results).toHaveLength(1)
      expect(results[0]!.status).toBe("completed")
      expect(results[0]!.text).toBe("hello")
      expect(results[0]!.sessionID).toBe("ses_fake_a")
      expect(types(yield* col.events())).toEqual(["run.started", "step.started", "step.finished", "run.finished"])
    }),
  )

  it.live("runs seq children in document order", () =>
    Effect.gen(function* () {
      const runner = yield* makeFakeRunner({ default: { delayMillis: 5 } })
      const node: IR = { kind: "seq", children: [agent("a"), agent("b"), agent("c")] }
      const results = yield* interpret({ runID: "wf_seq", node, runner })
      expect(results.map((r) => r.nodeID)).toEqual(["a", "b", "c"])
      expect(yield* runner.startOrder()).toEqual(["a", "b", "c"])
      expect(yield* runner.maxConcurrent()).toBe(1)
    }),
  )

  it.live("runs parallel children concurrently", () =>
    Effect.gen(function* () {
      const runner = yield* makeFakeRunner({ default: { delayMillis: 40 } })
      const node: IR = { kind: "parallel", children: [agent("a"), agent("b"), agent("c"), agent("d")] }
      const results = yield* interpret({ runID: "wf_par", node, runner })
      expect(results).toHaveLength(4)
      expect(yield* runner.maxConcurrent()).toBe(4)
    }),
  )

  it.live("enforces the global concurrency cap across the run", () =>
    Effect.gen(function* () {
      const runner = yield* makeFakeRunner({ default: { delayMillis: 40 } })
      const node: IR = {
        kind: "parallel",
        children: ["a", "b", "c", "d", "e", "f"].map((id) => agent(id)),
      }
      yield* interpret({ runID: "wf_cap", node, runner, concurrency: 2 })
      expect(yield* runner.maxConcurrent()).toBe(2)
    }),
  )

  it.live("caps concurrency even across nested parallel nodes", () =>
    Effect.gen(function* () {
      const runner = yield* makeFakeRunner({ default: { delayMillis: 40 } })
      const node: IR = {
        kind: "parallel",
        children: [
          { kind: "parallel", children: [agent("a"), agent("b")] },
          { kind: "parallel", children: [agent("c"), agent("d")] },
        ],
      }
      yield* interpret({ runID: "wf_nested", node, runner, concurrency: 3 })
      expect(yield* runner.maxConcurrent()).toBe(3)
    }),
  )

  it.live("fails fast and cancels siblings when a parallel child errors", () =>
    Effect.gen(function* () {
      const runner = yield* makeFakeRunner({
        behaviors: {
          bad: { failWith: "boom", delayMillis: 10 },
          slow: { delayMillis: 1000 },
        },
      })
      const col = yield* makeCollector
      const node: IR = { kind: "parallel", children: [agent("bad"), agent("slow")] }
      const exit = yield* interpret({ runID: "wf_fail", node, runner, emit: col.emit }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const events = yield* col.events()
      const byNode = (id: string) =>
        events.find((e) => e.type === "step.started" && e.nodeID === id) as Extract<Event, { type: "step.started" }>
      const stepStatus = (id: string) => {
        const stepID = byNode(id).stepID
        return finished(events).find((e) => e.stepID === stepID)?.status
      }
      expect(stepStatus("bad")).toBe("error")
      expect(stepStatus("slow")).toBe("cancelled")
      expect(runFinished(events)?.status).toBe("error")
    }),
  )

  it.live("propagates errors out of seq and stops subsequent steps", () =>
    Effect.gen(function* () {
      const runner = yield* makeFakeRunner({ behaviors: { b: { failWith: "nope" } }, default: {} })
      const node: IR = { kind: "seq", children: [agent("a"), agent("b"), agent("c")] }
      const exit = yield* interpret({ runID: "wf_seqfail", node, runner }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      // c must never have started because b failed first
      expect(yield* runner.startOrder()).toEqual(["a", "b"])
    }),
  )

  it.live("emits cancelled terminal events on interruption", () =>
    Effect.gen(function* () {
      const runner = yield* makeFakeRunner({ default: { delayMillis: 2000 } })
      const col = yield* makeCollector
      const fiber = yield* Effect.forkScoped(interpret({ runID: "wf_cancel", node: agent("a"), runner, emit: col.emit }))
      yield* Effect.sleep("40 millis")
      yield* Fiber.interrupt(fiber)
      const events = yield* col.events()
      expect(finished(events)[0]?.status).toBe("cancelled")
      expect(runFinished(events)?.status).toBe("cancelled")
    }),
  )

  it.live("passes structured output through to the step result", () =>
    Effect.gen(function* () {
      const runner = yield* makeFakeRunner({ behaviors: { a: { json: { count: 3 }, text: "ok" } } })
      const node: IR = agent("a", { schema: { type: "object", properties: { count: { type: "number" } } } })
      const results = yield* interpret({ runID: "wf_json", node, runner })
      expect(results[0]!.json).toEqual({ count: 3 })
    }),
  )

  it.live("emits log events and contributes no steps", () =>
    Effect.gen(function* () {
      const runner = yield* makeFakeRunner()
      const col = yield* makeCollector
      const node: IR = { kind: "seq", children: [{ kind: "log", message: "starting" }, agent("a")] }
      const results = yield* interpret({ runID: "wf_log", node, runner, emit: col.emit })
      expect(results).toHaveLength(1)
      const events = yield* col.events()
      const log = events.find((e) => e.type === "log") as Extract<Event, { type: "log" }>
      expect(log.message).toBe("starting")
    }),
  )

  it.live("carries phase onto the step.started event", () =>
    Effect.gen(function* () {
      const runner = yield* makeFakeRunner()
      const col = yield* makeCollector
      const node: IR = agent("a", { phase: "Discover" })
      yield* interpret({ runID: "wf_phase", node, runner, emit: col.emit })
      const started = (yield* col.events()).find((e) => e.type === "step.started") as Extract<
        Event,
        { type: "step.started" }
      >
      expect(started.phase).toBe("Discover")
    }),
  )

  it.live("flattens results from nested seq/parallel composition", () =>
    Effect.gen(function* () {
      const runner = yield* makeFakeRunner({ default: { delayMillis: 5 } })
      const node: IR = {
        kind: "seq",
        children: [
          agent("setup"),
          { kind: "parallel", children: [agent("x"), agent("y"), agent("z")] },
          agent("teardown"),
        ],
      }
      const results = yield* interpret({ runID: "wf_mix", node, runner })
      expect(results.map((r) => r.nodeID).sort()).toEqual(["setup", "teardown", "x", "y", "z"])
      expect(results.every((r) => r.status === "completed")).toBe(true)
    }),
  )
})
