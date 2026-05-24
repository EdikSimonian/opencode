import { wrapLanguageModel, type LanguageModelMiddleware } from "ai"
import type { LanguageModelV3, LanguageModelV3Content, LanguageModelV3StreamPart } from "@ai-sdk/provider"

/**
 * Tool-call recovery middleware for local / OpenAI-compatible backends.
 *
 * Some local model servers (llama.cpp, vLLM, LM Studio) — especially when
 * fronted by a gateway that can't parse a partial stream — fail to convert a
 * model's tool-call markup into structured `tool_calls`, instead leaking it
 * into the assistant message *content*. opencode then sees plain text, never
 * executes the tool, and exits the loop. This middleware parses tool calls back
 * out of content and synthesizes structured tool calls.
 *
 * Handles both dialects:
 *   - Qwen3-Coder XML:  <tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>
 *     (also tolerant of the unwrapped <function=...> form and arbitrary whitespace)
 *   - Hermes JSON:      <tool_call>{"name":"NAME","arguments":{...}}</tool_call>
 *
 * Streaming strategy: at the start of each text block we briefly hold deltas to
 * decide text-vs-tool. If it starts as a tool call we suppress the markup and
 * emit a structured tool call at finish. If it starts as text we forward the
 * provider's *original* parts incrementally (re-chunking or batching deltas
 * prevents opencode from finalizing the assistant text) and keep scanning, so a
 * tool call after some preamble is still recovered. No-op when the backend
 * already returns structured tool calls.
 */

interface ParsedCall {
  name: string
  args: Record<string, unknown>
}

const FUNCTION_RE = /<function\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/function>/g
const PARAM_RE = /<parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g
const TOOLCALL_JSON_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g

const MARKERS = ["<tool_call>", "<function="]

function coerce(raw: string): unknown {
  const v = raw.trim()
  if (v === "") return ""
  if (v === "true") return true
  if (v === "false") return false
  if (v === "null") return null
  if (/^-?\d+$/.test(v)) {
    const n = Number(v)
    if (Number.isSafeInteger(n)) return n
  }
  if (/^-?\d*\.\d+$/.test(v)) return Number(v)
  if ((v.startsWith("{") && v.endsWith("}")) || (v.startsWith("[") && v.endsWith("]"))) {
    try {
      return JSON.parse(v)
    } catch {
      /* keep as string */
    }
  }
  return v
}

export function parseToolCalls(text: string): ParsedCall[] {
  const calls: ParsedCall[] = []

  // Qwen3-Coder XML dialect.
  FUNCTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FUNCTION_RE.exec(text))) {
    const name = m[1].trim()
    if (!name) continue
    const body = m[2]
    const args: Record<string, unknown> = {}
    PARAM_RE.lastIndex = 0
    let p: RegExpExecArray | null
    while ((p = PARAM_RE.exec(body))) {
      args[p[1].trim()] = coerce(p[2])
    }
    calls.push({ name, args })
  }
  if (calls.length) return calls

  // Hermes JSON dialect.
  TOOLCALL_JSON_RE.lastIndex = 0
  while ((m = TOOLCALL_JSON_RE.exec(text))) {
    const inner = m[1].trim()
    try {
      const obj = JSON.parse(inner)
      if (obj && typeof obj.name === "string") {
        const args = (obj.arguments ?? obj.parameters ?? {}) as Record<string, unknown>
        calls.push({ name: obj.name, args: typeof args === "object" && args ? args : {} })
      }
    } catch {
      /* not JSON, skip */
    }
  }
  return calls
}

export function hasToolMarker(text: string): boolean {
  return text.includes("<tool_call>") || /<function\s*=/.test(text)
}

function earliestMarker(s: string): number {
  const a = s.indexOf("<tool_call>")
  const fn = s.search(/<function\s*=/)
  const candidates = [a, fn].filter((x) => x >= 0)
  return candidates.length ? Math.min(...candidates) : -1
}

// True while the sniff buffer could still grow into a tool-call marker.
function couldStartMarker(s: string): boolean {
  const lead = s.replace(/^\s+/, "")
  if (lead === "") return true
  return MARKERS.some((mk) => mk.startsWith(lead.slice(0, mk.length)))
}

function newToolCallId(): string {
  return "call_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16)
}

export const toolCallRecoveryMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",

  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate()
    if (result.content.some((p) => p.type === "tool-call")) return result

    let text = ""
    for (const p of result.content) if (p.type === "text") text += p.text
    if (!hasToolMarker(text)) return result

    const calls = parseToolCalls(text)
    if (!calls.length) return result

    const content: LanguageModelV3Content[] = calls.map((c) => ({
      type: "tool-call",
      toolCallId: newToolCallId(),
      toolName: c.name,
      input: JSON.stringify(c.args),
    }))
    return { ...result, content, finishReason: { unified: "tool-calls" as const, raw: result.finishReason.raw } }
  },

  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream()
    const DBG = !!process.env["OPENCODE_TCR_DEBUG"]
    type Part = LanguageModelV3StreamPart
    type TextDelta = Extract<Part, { type: "text-delta" }>
    type Controller = TransformStreamDefaultController<Part>

    let sawUpstreamToolCall = false
    let finished = false
    // "sniff": holding the start of a text block to decide text-vs-tool.
    // "text": confirmed text, forwarding originals incrementally (still scanning).
    // "capture": buffering tool-call markup to emit at finish.
    let phase: "sniff" | "text" | "capture" = "sniff"
    let savedStart: Extract<Part, { type: "text-start" }> | undefined
    let startForwarded = false
    let held: TextDelta[] = [] // original deltas held during sniff
    let sniffText = ""
    let seen = "" // text forwarded in the "text" phase (scanned for markers)
    let capture = ""

    const fwdStart = (c: Controller) => {
      if (startForwarded || !savedStart) return
      c.enqueue(savedStart)
      startForwarded = true
      if (DBG) console.error("[TCR] >text-start")
    }
    const flushHeld = (c: Controller) => {
      if (held.length) fwdStart(c)
      for (const p of held) {
        c.enqueue(p)
        if (DBG) console.error("[TCR] >text-delta(orig)", JSON.stringify(p.delta))
      }
      held = []
    }
    const emitTools = (c: Controller, src: string): number => {
      const calls = parseToolCalls(src)
      for (const cc of calls) {
        if (DBG) console.error("[TCR] >tool-call", cc.name, JSON.stringify(cc.args))
        c.enqueue({ type: "tool-call", toolCallId: newToolCallId(), toolName: cc.name, input: JSON.stringify(cc.args) })
      }
      return calls.length
    }

    const transform = new TransformStream<Part, Part>({
      transform(part, controller) {
        if (DBG && part.type !== "text-delta") console.error("[TCR <]", part.type)
        if (sawUpstreamToolCall) {
          controller.enqueue(part)
          return
        }
        switch (part.type) {
          case "tool-call":
          case "tool-input-start":
          case "tool-input-delta":
          case "tool-input-end":
            sawUpstreamToolCall = true
            flushHeld(controller)
            controller.enqueue(part)
            return
          case "text-start":
            savedStart = part
            startForwarded = false
            phase = "sniff"
            held = []
            sniffText = ""
            seen = ""
            capture = ""
            return
          case "text-delta": {
            const d = part.delta
            if (phase === "capture") {
              capture += d
              return
            }
            if (phase === "text") {
              // Forward originals incrementally; keep scanning for a later marker.
              fwdStart(controller)
              controller.enqueue(part)
              seen += d
              const idx = earliestMarker(seen)
              if (idx >= 0) {
                phase = "capture"
                capture = seen.slice(idx)
              }
              return
            }
            // sniff
            held.push(part as TextDelta)
            sniffText += d
            const idx = earliestMarker(sniffText)
            if (idx >= 0) {
              // starts as a tool call — suppress the held markup
              held = []
              phase = "capture"
              capture = sniffText.slice(idx)
            } else if (!couldStartMarker(sniffText)) {
              // confirmed text — release held originals and stream the rest
              flushHeld(controller)
              seen = sniffText
              phase = "text"
            }
            return
          }
          case "text-end":
            if (phase === "sniff") {
              const idx = earliestMarker(sniffText)
              if (idx >= 0) {
                held = []
                phase = "capture"
                capture = sniffText.slice(idx)
              } else {
                flushHeld(controller)
                phase = "text"
              }
            }
            if (phase === "capture") return // suppressed; tool calls emitted at finish
            if (startForwarded) controller.enqueue(part)
            return
          case "finish": {
            finished = true
            if (phase === "sniff") flushHeld(controller) // only-whitespace / tiny text
            if (phase === "capture" && hasToolMarker(capture)) {
              const n = emitTools(controller, capture)
              capture = ""
              if (n > 0) {
                if (startForwarded) controller.enqueue({ type: "text-end", id: savedStart?.id ?? "recovery-text" })
                controller.enqueue({
                  type: "finish",
                  usage: part.usage,
                  finishReason: { unified: "tool-calls" as const, raw: part.finishReason.raw },
                  providerMetadata: part.providerMetadata,
                })
                return
              }
            }
            controller.enqueue(part)
            return
          }
          default:
            controller.enqueue(part)
        }
      },
      flush(controller) {
        if (finished || sawUpstreamToolCall) return
        if (phase === "sniff") flushHeld(controller)
        if (phase === "capture" && hasToolMarker(capture)) {
          if (emitTools(controller, capture) > 0 && startForwarded) {
            controller.enqueue({ type: "text-end", id: savedStart?.id ?? "recovery-text" })
          }
        }
      },
    })

    return { stream: stream.pipeThrough(transform), ...rest }
  },
}

/** Wrap a language model with tool-call content recovery. */
export function withToolCallRecovery(model: LanguageModelV3): LanguageModelV3 {
  return wrapLanguageModel({ model, middleware: toolCallRecoveryMiddleware })
}
