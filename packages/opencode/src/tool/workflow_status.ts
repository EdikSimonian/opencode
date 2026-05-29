import * as Tool from "./tool"
import { WorkflowStore, type RunInfo } from "@/workflow/store"
import { Effect, Schema } from "effect"

const id = "workflow_status"

const DESCRIPTION = [
  "Inspect or cancel workflow runs started by the `workflow` tool in this session.",
  "",
  "actions:",
  "- list:   show all workflow runs and their status",
  "- get:    show one run's steps and status (requires run_id)",
  "- cancel: cancel a running workflow (requires run_id)",
  "",
  "Use this to check on a background workflow or to stop one early. Do not poll in a tight loop.",
].join("\n")

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "get", "cancel"]).annotate({
    description: "What to do: list all runs, get one run's detail, or cancel a run.",
  }),
  run_id: Schema.optional(Schema.String).annotate({
    description: "The workflow run id. Required for 'get' and 'cancel'.",
  }),
})

function duration(run: RunInfo): string {
  if (run.completed_at === undefined) return "running"
  return `${run.completed_at - run.started_at}ms`
}

function renderRunSummary(run: RunInfo): string {
  const done = run.steps.filter((s) => s.status !== "running").length
  return `${run.runID}  ${run.status}  steps=${done}/${run.steps.length}  ${duration(run)}${run.title ? `  ${run.title}` : ""}`
}

function renderRunDetail(run: RunInfo): string {
  const lines = [renderRunSummary(run), ...run.steps.map((s) => {
    const phase = s.phase ? ` [${s.phase}]` : ""
    const err = s.error ? `  error: ${s.error}` : ""
    return `  - ${s.nodeID} (@${s.agentType})${phase}  ${s.status}${err}`
  })]
  if (run.error) lines.push(`  error: ${run.error}`)
  return lines.join("\n")
}

export const WorkflowStatusTool = Tool.define(
  id,
  Effect.gen(function* () {
    const store = yield* WorkflowStore.Service

    const run = Effect.fn("WorkflowStatusTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      _ctx: Tool.Context,
    ) {
      const result = (input: { title: string; metadata: Record<string, unknown>; output: string }) => input

      switch (params.action) {
        case "list": {
          const runs = yield* store.list()
          const output = runs.length
            ? runs.map(renderRunSummary).join("\n")
            : "No workflow runs in this session."
          return result({ title: "workflow list", metadata: { count: runs.length }, output })
        }
        case "get": {
          if (!params.run_id) return yield* Effect.fail(new Error("run_id is required for action 'get'"))
          const found = yield* store.get(params.run_id)
          if (!found) return yield* Effect.fail(new Error(`No workflow run found with id ${params.run_id}`))
          return result({ title: `workflow ${found.status}`, metadata: { status: found.status }, output: renderRunDetail(found) })
        }
        case "cancel": {
          if (!params.run_id) return yield* Effect.fail(new Error("run_id is required for action 'cancel'"))
          const after = yield* store.cancel(params.run_id)
          if (!after) return yield* Effect.fail(new Error(`No workflow run found with id ${params.run_id}`))
          return result({ title: `workflow ${after.status}`, metadata: { status: after.status }, output: renderRunDetail(after) })
        }
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
