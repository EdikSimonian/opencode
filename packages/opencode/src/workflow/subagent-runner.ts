/**
 * The real SubagentRunner — spawns an opencode subagent per workflow step.
 *
 * This mirrors `TaskTool`'s spawn path (resolve agent → create child session →
 * derive permissions → pick model → `ops.prompt`) but adds two things the task
 * tool doesn't expose:
 *   1. structured output — when a step declares a `schema`, we pass `format`
 *      into `ops.prompt` and read the parsed value back off the assistant
 *      message's `structured` field;
 *   2. a plain `{ text, json, sessionID }` return shape instead of the task
 *      tool's XML-wrapped string, so the interpreter can aggregate results.
 *
 * Cancellation flows through Effect interruption: when the interpreter interrupts
 * a step (fail-fast or run cancellation), `ops.cancel` tears down the child
 * session, matching the task tool's foreground behavior.
 */
import { Effect } from "effect"
import { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import type { Agent } from "@/agent/agent"
import type { Session } from "@/session/session"
import type { Tool } from "@/tool/tool"
import type { TaskPromptOps } from "@/tool/task"
import { SubagentRunError, type RunStepInput, type RunStepOutput, type SubagentRunner } from "./runner"

function errorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const maybe = error as { message?: unknown; name?: unknown }
    if (typeof maybe.message === "string") return maybe.message
    if (typeof maybe.name === "string") return maybe.name
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

export function makeSubagentRunner(deps: {
  agent: Agent.Interface
  sessions: Session.Interface
  /** `cfg.experimental?.primary_tools ?? []` — denied to subagents like in TaskTool. */
  primaryTools: string[]
  ctx: Tool.Context
  ops: TaskPromptOps
}): SubagentRunner {
  const { agent, sessions, primaryTools, ctx, ops } = deps

  const run = (step: RunStepInput): Effect.Effect<RunStepOutput, SubagentRunError> =>
    Effect.gen(function* () {
      const next = yield* agent.get(step.agentType)
      if (!next)
        return yield* new SubagentRunError({
          nodeID: step.nodeID,
          message: `Unknown agent type: ${step.agentType} is not a valid agent type`,
        })

      const parent = yield* sessions.get(ctx.sessionID)
      const parentAgent = parent.agent
        ? yield* agent.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined

      const child = yield* sessions.create({
        parentID: ctx.sessionID,
        title: `${step.label} (@${next.name} subagent)`,
        permission: [
          ...deriveSubagentSessionPermission({
            parentSessionPermission: parent.permission ?? [],
            parentAgent,
            subagent: next,
          }),
          ...primaryTools.map((item) => ({ pattern: "*", action: "allow" as const, permission: item })),
        ],
      })

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(Effect.orDie)
      if (msg.info.role !== "assistant")
        return yield* new SubagentRunError({ nodeID: step.nodeID, message: "Parent message is not an assistant message" })

      const model = next.model ?? { modelID: msg.info.modelID, providerID: msg.info.providerID }
      const parts = yield* ops.resolvePromptParts(step.prompt)

      const result = yield* ops
        .prompt({
          messageID: MessageID.ascending(),
          sessionID: child.id,
          model: { modelID: model.modelID, providerID: model.providerID },
          agent: next.name,
          tools: {
            ...(next.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
            ...(next.permission.some((rule) => rule.permission === "task") ? {} : { task: false }),
            ...Object.fromEntries(primaryTools.map((item) => [item, false])),
          },
          parts,
          ...(step.schema ? { format: { type: "json_schema" as const, schema: step.schema } } : {}),
        })
        .pipe(Effect.onInterrupt(() => ops.cancel(child.id).pipe(Effect.ignore)))

      const info = result.info
      const assistantError = info.role === "assistant" ? info.error : undefined
      if (assistantError)
        return yield* new SubagentRunError({ nodeID: step.nodeID, message: errorText(assistantError) })

      const structured = info.role === "assistant" ? info.structured : undefined
      if (step.schema && structured === undefined)
        return yield* new SubagentRunError({
          nodeID: step.nodeID,
          message: "Subagent did not produce structured output for the requested schema",
        })

      const text = result.parts.findLast((part) => part.type === "text")?.text ?? ""
      return {
        text,
        json: structured,
        sessionID: child.id,
      } satisfies RunStepOutput
    }).pipe(
      // Normalize infra failures (session lookup/create, agent lookup) into the
      // step's typed error so the interpreter can attribute them to this node.
      Effect.catch((error) =>
        error instanceof SubagentRunError
          ? Effect.fail(error)
          : Effect.fail(new SubagentRunError({ nodeID: step.nodeID, message: errorText(error) })),
      ),
    )

  return { run }
}
