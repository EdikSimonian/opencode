/**
 * SubagentRunner — the abstraction the interpreter uses to actually run a
 * subagent. Decoupling the interpreter from opencode's session machinery keeps
 * the interpreter unit-testable (with `makeFakeRunner`) and lets us swap the
 * real implementation independently.
 */
import { Data, Effect, Ref } from "effect"

export class SubagentRunError extends Data.TaggedError("SubagentRunError")<{
  readonly nodeID: string
  readonly message: string
}> {}

export interface RunStepInput {
  readonly nodeID: string
  readonly label: string
  readonly agentType: string
  readonly prompt: string
  /** When present, the subagent is forced to return structured JSON output. */
  readonly schema?: Record<string, unknown>
}

export interface RunStepOutput {
  readonly text: string
  readonly json?: unknown
  readonly sessionID?: string
}

export interface SubagentRunner {
  run(input: RunStepInput): Effect.Effect<RunStepOutput, SubagentRunError>
}

// ---------------------------------------------------------------------------
// Fake runner (tests)
// ---------------------------------------------------------------------------

export interface FakeStepBehavior {
  /** Final text to return. Defaults to a synthetic string derived from nodeID. */
  text?: string
  /** Structured output to return (echoed back regardless of schema). */
  json?: unknown
  /** When set, the step fails with this message instead of succeeding. */
  failWith?: string
  /** Artificial delay so concurrency/ordering is observable in tests (ms). */
  delayMillis?: number
}

export interface FakeRunner extends SubagentRunner {
  /** Highest number of steps observed running at the same instant. */
  maxConcurrent(): Effect.Effect<number>
  /** nodeIDs in the order their runs started. */
  startOrder(): Effect.Effect<string[]>
  /** nodeIDs in the order their runs completed (success only). */
  finishOrder(): Effect.Effect<string[]>
}

export function makeFakeRunner(opts?: {
  behaviors?: Record<string, FakeStepBehavior>
  default?: FakeStepBehavior
}): Effect.Effect<FakeRunner> {
  return Effect.gen(function* () {
    const active = yield* Ref.make(0)
    const max = yield* Ref.make(0)
    const started = yield* Ref.make<string[]>([])
    const finished = yield* Ref.make<string[]>([])

    const run = (input: RunStepInput) =>
      Effect.gen(function* () {
        const behavior = opts?.behaviors?.[input.nodeID] ?? opts?.default ?? {}
        yield* Ref.update(started, (xs) => [...xs, input.nodeID])
        const current = yield* Ref.updateAndGet(active, (n) => n + 1)
        yield* Ref.update(max, (m) => (current > m ? current : m))
        return yield* Effect.gen(function* () {
          if (behavior.delayMillis) yield* Effect.sleep(`${behavior.delayMillis} millis`)
          if (behavior.failWith)
            return yield* new SubagentRunError({ nodeID: input.nodeID, message: behavior.failWith })
          yield* Ref.update(finished, (xs) => [...xs, input.nodeID])
          return {
            text: behavior.text ?? `result:${input.nodeID}`,
            json: behavior.json,
            sessionID: `ses_fake_${input.nodeID}`,
          } satisfies RunStepOutput
        }).pipe(Effect.ensuring(Ref.update(active, (n) => n - 1)))
      })

    return {
      run,
      maxConcurrent: () => Ref.get(max),
      startOrder: () => Ref.get(started),
      finishOrder: () => Ref.get(finished),
    }
  })
}
