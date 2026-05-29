/**
 * Workflow run/step lifecycle events.
 *
 * The interpreter is decoupled from any sink: it emits these events through a
 * caller-supplied function. The in-memory run store (`store.ts`) consumes them
 * to maintain queryable status; later phases can additionally persist them to
 * the event log for durable resume.
 */
import { Effect } from "effect"
import type { StepStatus } from "./ir"

export type RunStatus = "running" | "completed" | "error" | "cancelled"

export interface RunStarted {
  type: "run.started"
  runID: string
  at: number
}

export interface RunFinished {
  type: "run.finished"
  runID: string
  status: RunStatus
  at: number
  error?: string
}

export interface StepStarted {
  type: "step.started"
  runID: string
  stepID: string
  nodeID: string
  label: string
  agentType: string
  phase?: string
  at: number
}

export interface StepFinished {
  type: "step.finished"
  runID: string
  stepID: string
  status: StepStatus
  at: number
  error?: string
}

export interface LogEmitted {
  type: "log"
  runID: string
  message: string
  at: number
}

export type Event = RunStarted | RunFinished | StepStarted | StepFinished | LogEmitted

/** A sink for workflow events. Returning an Effect lets sinks do real I/O. */
export type Emit = (event: Event) => Effect.Effect<void>

/** A no-op sink, handy for tests and fire-and-forget runs. */
export const noopEmit: Emit = () => Effect.void
