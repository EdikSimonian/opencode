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

    // Emit the terminal event for a unit of work given how it exited. Shared by
    // step- and run-level lifecycle so the rule is identical everywhere.
    const emitTerminal = (exit: Exit.Exit<unknown, unknown>, onStatus: (status: "completed" | "error" | "cancelled", error?: string) => Effect.Effect<void>) =>
      Exit.match(exit, {
        onSuccess: () => onStatus("completed"),
        onFailure: (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? onStatus("cancelled")
            : onStatus("error", errorText(Cause.squash(cause))),
      })

    const runAgent = (agent: AgentNode): Effect.Effect<StepResult[], InterpretError> => {
      const stepID = Identifier.ascending("workflowstep")
      const label = agent.label ?? agent.id
      // acquireUseRelease pairs the started/finished events atomically: acquire
      // runs uninterruptibly and release always runs, so a step can never be
      // left "started" without a terminal event even if interrupted in between.
      return Effect.acquireUseRelease(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((at) =>
            emit({
              type: "step.started",
              runID,
              stepID,
              nodeID: agent.id,
              label,
              agentType: agent.agentType,
              phase: agent.phase,
              at,
            }),
          ),
        ),
        () =>
          sem.withPermits(1)(
            runner.run({
              nodeID: agent.id,
              label,
              agentType: agent.agentType,
              prompt: agent.prompt,
              schema: agent.schema,
            }),
          ),
        (_, exit) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((at) =>
              emitTerminal(exit, (status, error) =>
                emit({ type: "step.finished", runID, stepID, status, at, error }),
              ),
            ),
          ),
      ).pipe(
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
    }

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

    return yield* Effect.acquireUseRelease(
      Clock.currentTimeMillis.pipe(Effect.flatMap((at) => emit({ type: "run.started", runID, at }))),
      () => go(node),
      (_, exit) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((at) =>
            emitTerminal(exit, (status, error) => emit({ type: "run.finished", runID, status, at, error })),
          ),
        ),
    )
  })
}
