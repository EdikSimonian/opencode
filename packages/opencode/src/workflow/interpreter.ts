/**
 * Workflow interpreter.
 *
 * Walks an IR tree and executes it, emitting lifecycle events as it goes. The
 * interpreter owns three concerns and nothing else:
 *   1. control flow  — `seq` runs children in order, `parallel` runs them as a
 *      barrier (fail-fast: the first failure interrupts the rest);
 *   2. concurrency    — a single global semaphore caps how many subagents run at
 *      once across the *entire* run (matching Claude Code's global cap), so even
 *      nested `parallel` nodes can't exceed it;
 *   3. lifecycle      — exactly one terminal event per step/run, emitted from an
 *      `onExit` finalizer so it survives interruption (cancellation).
 *
 * Everything subagent-specific lives behind `SubagentRunner`, which keeps this
 * module pure enough to unit-test with a fake runner.
 *
 * Failure semantics here are intentionally simple (fail-fast). Richer policies
 * (per-step `optional`, collect-and-continue) are a later phase.
 */
import { Cause, Clock, Data, Effect, Exit, Semaphore } from "effect"
import { Identifier } from "@/id/id"
import type { AgentNode, IR, StepResult } from "./ir"
import type { Emit } from "./events"
import type { SubagentRunner } from "./runner"

export class InterpretError extends Data.TaggedError("WorkflowInterpretError")<{
  readonly nodeID?: string
  readonly message: string
}> {}

export const DEFAULT_CONCURRENCY = 8

export interface InterpretInput {
  readonly runID: string
  readonly node: IR
  readonly runner: SubagentRunner
  readonly emit?: Emit
  /** Max concurrent subagents across the whole run. Defaults to 8. */
  readonly concurrency?: number
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function interpret(input: InterpretInput): Effect.Effect<StepResult[], InterpretError> {
  return Effect.gen(function* () {
    const { runID, node, runner } = input
    const emit: Emit = input.emit ?? (() => Effect.void)
    const concurrency = Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY)
    const sem = yield* Semaphore.make(concurrency)

    const runAgent = (agent: AgentNode): Effect.Effect<StepResult[], InterpretError> =>
      Effect.gen(function* () {
        const stepID = Identifier.ascending("workflowstep")
        const label = agent.label ?? agent.id
        const startedAt = yield* Clock.currentTimeMillis
        yield* emit({
          type: "step.started",
          runID,
          stepID,
          nodeID: agent.id,
          label,
          agentType: agent.agentType,
          phase: agent.phase,
          at: startedAt,
        })
        return yield* sem
          .withPermits(1)(
            runner.run({
              nodeID: agent.id,
              label,
              agentType: agent.agentType,
              prompt: agent.prompt,
              schema: agent.schema,
            }),
          )
          .pipe(
            // Finalizer: guarantees exactly one terminal event regardless of
            // success / failure / interruption (runs uninterruptibly).
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                const at = yield* Clock.currentTimeMillis
                yield* Exit.match(exit, {
                  onSuccess: () =>
                    emit({ type: "step.finished", runID, stepID, status: "completed", at }),
                  onFailure: (cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? emit({ type: "step.finished", runID, stepID, status: "cancelled", at })
                      : emit({
                          type: "step.finished",
                          runID,
                          stepID,
                          status: "error",
                          at,
                          error: errorText(Cause.squash(cause)),
                        }),
                })
              }),
            ),
            Effect.map(
              (out): StepResult[] => [
                {
                  stepID,
                  nodeID: agent.id,
                  label,
                  agentType: agent.agentType,
                  status: "completed",
                  text: out.text,
                  json: out.json,
                  sessionID: out.sessionID,
                },
              ],
            ),
            Effect.mapError((err) => new InterpretError({ nodeID: agent.id, message: err.message })),
          )
      })

    const go = (n: IR): Effect.Effect<StepResult[], InterpretError> => {
      switch (n.kind) {
        case "agent":
          return runAgent(n)
        case "log":
          return Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            yield* emit({ type: "log", runID, message: n.message, at })
            return []
          })
        case "seq":
          return Effect.gen(function* () {
            const acc: StepResult[] = []
            for (const child of n.children) acc.push(...(yield* go(child)))
            return acc
          })
        case "parallel":
          return Effect.all(
            n.children.map((child) => go(child)),
            { concurrency: "unbounded" },
          ).pipe(Effect.map((results) => results.flat()))
      }
    }

    const startedAt = yield* Clock.currentTimeMillis
    yield* emit({ type: "run.started", runID, at: startedAt })
    return yield* go(node).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          yield* Exit.match(exit, {
            onSuccess: () => emit({ type: "run.finished", runID, status: "completed", at }),
            onFailure: (cause) =>
              Cause.hasInterruptsOnly(cause)
                ? emit({ type: "run.finished", runID, status: "cancelled", at })
                : emit({
                    type: "run.finished",
                    runID,
                    status: "error",
                    at,
                    error: errorText(Cause.squash(cause)),
                  }),
          })
        }),
      ),
    )
  })
}
