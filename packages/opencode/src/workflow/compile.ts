/**
 * Compile the declarative workflow document (the public authoring surface) into
 * the executable IR.
 *
 * Why a hand-written compiler instead of a recursive effect Schema:
 *   - one place owns *all* structural validation, so the error messages we feed
 *     back to the model are precise ("steps[1].agent must be a non-empty
 *     string") rather than a generic schema dump;
 *   - it lets us assign stable step ids and check id uniqueness, which a decoder
 *     can't do;
 *   - the model-facing JSON Schema (below) stays free of `$ref`, which some
 *     provider schema transforms mangle.
 *
 * The document shape (top-level `steps` runs as an implicit `seq`):
 *   { "concurrency"?: number, "steps": Step[] }
 *   Step =
 *     | { "type": "agent", "agent": string, "prompt": string,
 *         "id"?: string, "label"?: string, "phase"?: string, "schema"?: object }
 *     | { "type": "log", "message": string }
 *     | { "type": "seq", "steps": Step[] }
 *     | { "type": "parallel", "steps": Step[] }
 */
import { Schema } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { IR } from "./ir"

export class CompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowCompileError"
  }
}

export interface CompiledWorkflow {
  ir: IR
  concurrency?: number
}

/** Permissive tool-parameter schema; the real validation lives in `compile`. */
export const Parameters = Schema.Struct({
  concurrency: Schema.optional(Schema.Number),
  steps: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
})

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new CompileError(`${path} must be a non-empty string`)
  return value
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, path)
}

export function compile(input: unknown): CompiledWorkflow {
  if (!isObject(input)) throw new CompileError("workflow must be an object")

  let concurrency: number | undefined
  if (input.concurrency !== undefined) {
    const c = input.concurrency
    if (typeof c !== "number" || !Number.isInteger(c) || c < 1)
      throw new CompileError("workflow.concurrency must be a positive integer")
    concurrency = c
  }

  if (!Array.isArray(input.steps)) throw new CompileError("workflow.steps must be an array")
  if (input.steps.length === 0) throw new CompileError("workflow.steps must not be empty")

  const usedIds = new Set<string>()
  let autoCounter = 0
  const nextAutoId = () => {
    let id: string
    do {
      id = `step${++autoCounter}`
    } while (usedIds.has(id))
    return id
  }

  const compileStep = (raw: unknown, path: string): IR => {
    if (!isObject(raw)) throw new CompileError(`${path} must be an object`)
    const type = raw.type
    switch (type) {
      case "agent": {
        const id = optionalString(raw.id, `${path}.id`)
        if (id !== undefined && usedIds.has(id))
          throw new CompileError(`${path}.id "${id}" is not unique within the workflow`)
        const resolvedId = id ?? nextAutoId()
        usedIds.add(resolvedId)
        let schema: Record<string, unknown> | undefined
        if (raw.schema !== undefined) {
          if (!isObject(raw.schema)) throw new CompileError(`${path}.schema must be a JSON Schema object`)
          schema = raw.schema
        }
        return {
          kind: "agent",
          id: resolvedId,
          agentType: requireString(raw.agent, `${path}.agent`),
          prompt: requireString(raw.prompt, `${path}.prompt`),
          label: optionalString(raw.label, `${path}.label`),
          phase: optionalString(raw.phase, `${path}.phase`),
          schema,
        }
      }
      case "log":
        return { kind: "log", message: requireString(raw.message, `${path}.message`) }
      case "seq":
      case "parallel": {
        if (!Array.isArray(raw.steps)) throw new CompileError(`${path}.steps must be an array`)
        if (raw.steps.length === 0) throw new CompileError(`${path}.steps must not be empty`)
        const children = raw.steps.map((child, i) => compileStep(child, `${path}.steps[${i}]`))
        return { kind: type, children }
      }
      default:
        throw new CompileError(
          `${path}.type must be one of "agent", "log", "seq", "parallel" (got ${JSON.stringify(type)})`,
        )
    }
  }

  const children = input.steps.map((step, i) => compileStep(step, `steps[${i}]`))
  const ir: IR = children.length === 1 ? children[0]! : { kind: "seq", children }
  return { ir, concurrency }
}

/**
 * Model-facing JSON Schema for the workflow document. Deliberately `$ref`-free
 * and self-describing; `compile` does the strict checking and reports precise
 * errors back to the model when something is off.
 */
export const WORKFLOW_JSON_SCHEMA: JSONSchema7 = {
  type: "object",
  required: ["steps"],
  properties: {
    concurrency: {
      type: "integer",
      minimum: 1,
      description: "Optional cap on how many subagents run at once across the whole workflow. Defaults to 8.",
    },
    steps: {
      type: "array",
      minItems: 1,
      description: [
        "Ordered list of steps. The top-level list runs sequentially (an implicit seq).",
        "Each step is one of these shapes (discriminated by `type`):",
        '- {"type":"agent","agent":<subagent type>,"prompt":<task>,"id"?:<unique id>,"label"?:<display label>,"phase"?:<group label>,"schema"?:<JSON Schema for structured output>}',
        '- {"type":"log","message":<progress message>}',
        '- {"type":"seq","steps":[...]}  run nested steps in order',
        '- {"type":"parallel","steps":[...]}  run nested steps concurrently (barrier; fail-fast)',
      ].join("\n"),
      items: {
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string", enum: ["agent", "log", "seq", "parallel"] },
          agent: { type: "string", description: "Subagent type to spawn (agent steps)." },
          prompt: { type: "string", description: "Task prompt for the subagent (agent steps)." },
          id: { type: "string", description: "Optional unique id for this step." },
          label: { type: "string", description: "Optional human-facing label." },
          phase: { type: "string", description: "Optional phase/group label for status display." },
          schema: { type: "object", description: "Optional JSON Schema forcing structured output." },
          message: { type: "string", description: "Progress message (log steps)." },
          steps: { type: "array", description: "Nested steps (seq/parallel steps)." },
        },
      },
    },
  },
}
