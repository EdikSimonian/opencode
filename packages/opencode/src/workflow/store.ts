/**
 * In-memory workflow run/step status store.
 *
 * This is a *live view* of in-flight and recently-finished runs, fed entirely by
 * interpreter events through `sink(runID)`. It is the backing data for the
 * status tool and for cancellation. It is intentionally NOT the durable source
 * of truth — durable resume (run/step events persisted to the event log) is a
 * later phase; if the process restarts, this map is empty.
 *
 * Modeled on `background/job.ts` (SynchronizedRef<Map>, snapshot-on-read).
 */
import { InstanceState } from "@/effect/instance-state"
import { Context, Effect, Layer, SynchronizedRef } from "effect"
import type { Emit, Event, RunStatus } from "./events"
import type { StepStatus } from "./ir"

export interface StepInfo {
  stepID: string
  nodeID: string
  label: string
  agentType: string
  phase?: string
  status: "running" | StepStatus
  started_at: number
  completed_at?: number
  error?: string
}

export interface RunInfo {
  runID: string
  title?: string
  status: RunStatus
  started_at: number
  completed_at?: number
  error?: string
  steps: StepInfo[]
  metadata?: Record<string, unknown>
}

interface Record_ {
  info: Omit<RunInfo, "steps">
  steps: Map<string, StepInfo>
  /** Effect that cancels the run (interrupt the fiber, cancel subagent sessions). */
  cancel?: Effect.Effect<void>
}

type State = {
  runs: SynchronizedRef.SynchronizedRef<Map<string, Record_>>
}

export interface Interface {
  readonly list: () => Effect.Effect<RunInfo[]>
  readonly get: (runID: string) => Effect.Effect<RunInfo | undefined>
  /** Returns an event sink that maintains status for the given run. */
  readonly sink: (runID: string, init?: { title?: string; metadata?: Record<string, unknown> }) => Emit
  /** Register how to cancel a run (used by the status/cancel tool). */
  readonly setCancel: (runID: string, cancel: Effect.Effect<void>) => Effect.Effect<void>
  /** Cancel a running workflow; no-op if unknown or already finished. */
  readonly cancel: (runID: string) => Effect.Effect<RunInfo | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowStore") {}

function snapshot(record: Record_): RunInfo {
  return {
    ...record.info,
    steps: Array.from(record.steps.values())
      .map((s) => ({ ...s }))
      .toSorted((a, b) => a.started_at - b.started_at),
    ...(record.info.metadata ? { metadata: { ...record.info.metadata } } : {}),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(
      Effect.fn("WorkflowStore.state")(function* () {
        return { runs: yield* SynchronizedRef.make(new Map<string, Record_>()) }
      }),
    )

    const update = (runID: string, f: (record: Record_) => Record_) =>
      Effect.gen(function* () {
        const s = yield* InstanceState.get(state)
        yield* SynchronizedRef.update(s.runs, (runs) => {
          const record = runs.get(runID)
          if (!record) return runs
          return new Map(runs).set(runID, f(record))
        })
      })

    const apply = (runID: string, init: { title?: string; metadata?: Record<string, unknown> } | undefined) =>
      Effect.fn("WorkflowStore.apply")(function* (event: Event) {
        const s = yield* InstanceState.get(state)
        yield* SynchronizedRef.update(s.runs, (runs) => {
          const next = new Map(runs)
          const record = next.get(runID)
          switch (event.type) {
            case "run.started": {
              next.set(runID, {
                info: {
                  runID,
                  title: init?.title,
                  status: "running",
                  started_at: event.at,
                  metadata: init?.metadata,
                },
                steps: new Map(),
                cancel: record?.cancel,
              })
              return next
            }
            case "run.finished": {
              if (!record) return next
              next.set(runID, {
                ...record,
                info: { ...record.info, status: event.status, completed_at: event.at, error: event.error },
              })
              return next
            }
            case "step.started": {
              if (!record) return next
              const steps = new Map(record.steps)
              steps.set(event.stepID, {
                stepID: event.stepID,
                nodeID: event.nodeID,
                label: event.label,
                agentType: event.agentType,
                phase: event.phase,
                status: "running",
                started_at: event.at,
              })
              next.set(runID, { ...record, steps })
              return next
            }
            case "step.finished": {
              if (!record) return next
              const existing = record.steps.get(event.stepID)
              if (!existing) return next
              const steps = new Map(record.steps)
              steps.set(event.stepID, {
                ...existing,
                status: event.status,
                completed_at: event.at,
                error: event.error,
              })
              next.set(runID, { ...record, steps })
              return next
            }
            case "log":
              return next
          }
        })
      })

    const sink: Interface["sink"] = (runID, init) => apply(runID, init)

    const setCancel: Interface["setCancel"] = (runID, cancel) =>
      update(runID, (record) => ({ ...record, cancel }))

    const list: Interface["list"] = Effect.fn("WorkflowStore.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Array.from((yield* SynchronizedRef.get(s.runs)).values())
        .map(snapshot)
        .toSorted((a, b) => a.started_at - b.started_at)
    })

    const get: Interface["get"] = Effect.fn("WorkflowStore.get")(function* (runID) {
      const s = yield* InstanceState.get(state)
      const record = (yield* SynchronizedRef.get(s.runs)).get(runID)
      return record ? snapshot(record) : undefined
    })

    const cancel: Interface["cancel"] = Effect.fn("WorkflowStore.cancel")(function* (runID) {
      const s = yield* InstanceState.get(state)
      const record = (yield* SynchronizedRef.get(s.runs)).get(runID)
      if (!record) return undefined
      if (record.info.status !== "running") return snapshot(record)
      if (record.cancel) yield* record.cancel.pipe(Effect.ignore)
      const after = (yield* SynchronizedRef.get(s.runs)).get(runID)
      return after ? snapshot(after) : undefined
    })

    return Service.of({ list, get, sink, setCancel, cancel })
  }),
)

export const defaultLayer = layer

export * as WorkflowStore from "./store"
