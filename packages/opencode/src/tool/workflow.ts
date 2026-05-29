import * as Tool from "./tool"
import DESCRIPTION from "./workflow.txt"
import { Agent } from "../agent/agent"
import { Session } from "@/session/session"
import { Config } from "@/config/config"
import { BackgroundJob } from "@/background/job"
import { Identifier } from "@/id/id"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { TaskPromptOps } from "./task"
import { compile, Parameters as DocParameters, WORKFLOW_JSON_SCHEMA, CompileError } from "@/workflow/compile"
import { interpret } from "@/workflow/interpreter"
import { makeSubagentRunner } from "@/workflow/subagent-runner"
import { formatWorkflowOutput } from "@/workflow/format"
import { WorkflowStore } from "@/workflow/store"
import { Cause, Effect, Exit, Fiber, Schema, Scope } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"

const id = "workflow"

export const Parameters = Schema.Struct({
  ...DocParameters.fields,
  background: Schema.optional(Schema.Boolean).annotate({
    description: "Run the workflow in the background and return immediately. You will be notified when it finishes.",
  }),
})

function modelSchema(allowBackground: boolean): JSONSchema7 {
  if (!allowBackground) return WORKFLOW_JSON_SCHEMA
  return {
    ...WORKFLOW_JSON_SCHEMA,
    properties: {
      ...WORKFLOW_JSON_SCHEMA.properties,
      background: {
        type: "boolean",
        description: "Run the workflow in the background and return immediately; you are notified when it finishes.",
      },
    },
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function backgroundOutput(runID: string): string {
  return [
    `<workflow id="${runID}" state="running">`,
    "<summary>Background workflow started</summary>",
    "Background workflow started. You will be notified automatically when it finishes; do not poll for progress.",
    "Continue only with non-overlapping work, or stop if there is nothing else useful to do.",
    "</workflow>",
  ].join("\n")
}

function backgroundMessage(input: { runID: string; state: "completed" | "error"; text: string }): string {
  const title =
    input.state === "completed" ? `Background workflow completed: ${input.runID}` : `Background workflow failed: ${input.runID}`
  return [
    `<workflow id="${input.runID}" state="${input.state}">`,
    `<summary>${title}</summary>`,
    input.text,
    "</workflow>",
  ].join("\n")
}

export const WorkflowTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    const store = yield* WorkflowStore.Service
    const background = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service
    const scope = yield* Scope.Scope

    const run = Effect.fn("WorkflowTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents)
        return yield* Effect.fail(new Error("Background workflows require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"))

      const compiled = yield* Effect.try({
        try: () => compile(params),
        catch: (e) =>
          new Error(
            e instanceof CompileError
              ? `Invalid workflow document: ${e.message}. Fix the workflow and try again.`
              : `Invalid workflow document: ${errorText(e)}`,
          ),
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return yield* Effect.fail(new Error("WorkflowTool requires promptOps in ctx.extra"))

      const cfg = yield* config.get()
      const primaryTools = cfg.experimental?.primary_tools ?? []

      const runID = Identifier.ascending("workflow")
      const title = `workflow (${compiled.ir.kind})`
      const metadata = {
        parentSessionId: ctx.sessionID,
        runID,
        ...(runInBackground ? { background: true } : {}),
      }
      yield* ctx.metadata({ title, metadata })

      const runner = makeSubagentRunner({ agent, sessions, primaryTools, ctx, ops })
      const emit = store.sink(runID, { title, metadata })
      const program = interpret({
        runID,
        node: compiled.ir,
        runner,
        emit,
        concurrency: compiled.concurrency,
      })

      if (runInBackground) {
        const inject = (state: "completed" | "error", text: string) =>
          Effect.gen(function* () {
            const parent = yield* sessions.get(ctx.sessionID)
            yield* ops
              .prompt({
                sessionID: ctx.sessionID,
                agent: parent.agent ?? ctx.agent,
                parts: [
                  { type: "text", synthetic: true, text: backgroundMessage({ runID, state, text }) },
                ],
              })
              .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
          })

        const info = yield* background.start({
          id: runID,
          type: id,
          title,
          metadata,
          run: program.pipe(
            Effect.map((results) => formatWorkflowOutput({ runID, status: "completed", results })),
            Effect.tap((text) => inject("completed", text).pipe(Effect.ignore)),
            Effect.catchCause((cause) =>
              (Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : inject("error", errorText(Cause.squash(cause))).pipe(Effect.ignore)
              ).pipe(Effect.andThen(Effect.failCause(cause))),
            ),
          ),
        })
        yield* store.setCancel(runID, background.cancel(runID).pipe(Effect.asVoid))
        return { title, metadata: { ...metadata, jobId: info.id }, output: backgroundOutput(runID) }
      }

      // Foreground: fork so the parent's abort signal can interrupt the whole
      // run (which cascades cancellation to every in-flight subagent session).
      const fiber = yield* program.pipe(Effect.forkIn(scope, { startImmediately: true }))
      yield* store.setCancel(runID, Fiber.interrupt(fiber).pipe(Effect.asVoid))
      const bridge = yield* EffectBridge.make()
      const onAbort = () => {
        bridge.fork(Fiber.interrupt(fiber))
      }
      if (ctx.abort.aborted) onAbort()
      else ctx.abort.addEventListener("abort", onAbort)

      const exit = yield* Fiber.await(fiber).pipe(
        Effect.ensuring(Effect.sync(() => ctx.abort.removeEventListener("abort", onAbort))),
      )

      if (Exit.isSuccess(exit))
        return {
          title,
          metadata,
          output: formatWorkflowOutput({ runID, status: "completed", results: exit.value }),
        }

      if (Cause.hasInterruptsOnly(exit.cause))
        return {
          title,
          metadata,
          output: `<workflow id="${runID}" state="cancelled"><summary>Workflow cancelled</summary></workflow>`,
        }

      return yield* Effect.fail(new Error(`Workflow failed: ${errorText(Cause.squash(exit.cause))}`))
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      jsonSchema: modelSchema(flags.experimentalBackgroundSubagents),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
