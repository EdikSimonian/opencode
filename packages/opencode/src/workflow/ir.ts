/**
 * Workflow intermediate representation (IR).
 *
 * The IR is the internal, executable shape of a workflow. The public authoring
 * surface (a declarative JSON document — see `compile.ts`) is compiled down to
 * this tree before the interpreter runs it. Keeping the IR separate from the
 * authoring surface means we can add new front-ends (a richer declarative DSL,
 * or eventually a sandboxed JS script) without touching the interpreter.
 *
 * Design notes:
 * - This is a *tree*, not a DAG schema. Control flow is expressed by nesting
 *   `seq` / `parallel` nodes, the same way Claude Code's interpreter composes
 *   `pipeline` / `parallel`.
 * - "Phase" is an attribute on agent nodes (used purely for grouping in the
 *   status UI), not a stateful cursor — that keeps the tree referentially
 *   transparent and easy to replay.
 */

/** A single subagent invocation — the only leaf that does real work. */
export interface AgentNode {
  kind: "agent"
  /** Stable authoring id within the workflow (from the source doc). */
  id: string
  /** Human-facing label for status output; defaults to `id` when absent. */
  label?: string
  /** The subagent type to spawn (must be a known opencode agent). */
  agentType: string
  /** The prompt template handed to the subagent. */
  prompt: string
  /**
   * Optional JSON Schema. When present the subagent is forced to return
   * structured output and the step result carries the parsed `json`.
   */
  schema?: Record<string, unknown>
  /** Optional phase label for grouping in the status display. */
  phase?: string
}

/** Run children one after another; stop at the first failure. */
export interface SeqNode {
  kind: "seq"
  children: IR[]
}

/**
 * Run children concurrently (subject to the global concurrency cap) and wait
 * for all of them — a barrier. Fails fast: the first child failure interrupts
 * the rest.
 */
export interface ParallelNode {
  kind: "parallel"
  children: IR[]
}

/** Emit a progress message into the run's event stream. */
export interface LogNode {
  kind: "log"
  message: string
}

export type IR = AgentNode | SeqNode | ParallelNode | LogNode

export type StepStatus = "completed" | "error" | "cancelled"

/** The outcome of a single agent step, returned by the interpreter. */
export interface StepResult {
  stepID: string
  nodeID: string
  label: string
  agentType: string
  status: StepStatus
  /** Final assistant text from the subagent (empty on error/cancel). */
  text: string
  /** Parsed structured output, when the node declared a schema. */
  json?: unknown
  /** The subagent session id, when one was created. */
  sessionID?: string
  /** Error message when `status === "error"`. */
  error?: string
}
