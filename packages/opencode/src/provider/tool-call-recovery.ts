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
 * Design: it sniffs only the *start* of each assistant text block. If a tool
 * marker appears there, it buffers the rest and emits structured tool calls at
 * finish. Otherwise it replays the original upstream stream parts byte-for-byte
 * (no re-chunking), so ordinary text answers render exactly as the provider
 * sent them. It is a complete no-op when the backend already returns structured
 * tool calls.
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
    type Controller = TransformStreamDefaultController<Part>

    let sawUpstreamToolCall = false
    let finished = false
    // phase: "sniff" (buffering start of a text block to decide), "passthrough"
    // (confirmed plain text — forward originals), "capture" (buffering a tool call).
    let phase: "sniff" | "passthrough" | "capture" = "sniff"
    let buffered: Part[] = [] // original parts withheld during sniff
    let sniffText = ""
    let capture = ""

    const flushBuffered = (c: Controller) => {
      for (const p of buffered) c.enqueue(p)
      buffered = []
    }
    const emitTools = (c: Controller, src: string): number => {
      const calls = parseToolCalls(src)
      for (const cc of calls) {
        if (DBG) console.error("[TCR] recovered tool-call", cc.name, JSON.stringify(cc.args))
        c.enqueue({ type: "tool-call", toolCallId: newToolCallId(), toolName: cc.name, input: JSON.stringify(cc.args) })
      }
      return calls.length
    }
    // Resolve the sniff decision once we have a delta; may transition phase.
    const decideSniff = (c: Controller) => {
      const idx = earliestMarker(sniffText)
      if (idx >= 0) {
        // Tool call begins. Drop the withheld text parts (they belong to the
        // tool markup, not user-visible text) and start capturing.
        buffered = []
        phase = "capture"
        capture = sniffText
        sniffText = ""
        return
      }
      if (!couldStartMarker(sniffText)) {
        // Plain text — replay the originals untouched and stop intercepting.
        flushBuffered(c)
        phase = "passthrough"
        sniffText = ""
      }
    }

    const transform = new TransformStream<Part, Part>({
      transform(part, controller) {
        if (DBG && part.type !== "text-delta") console.error("[TCR in]", part.type)
        if (sawUpstreamToolCall) {
          controller.enqueue(part)
          return
        }
        switch (part.type) {
          case "tool-call":
          case "tool-input-start":
          case "tool-input-delta":
          case "tool-input-end":
            // Backend already produced structured tool calls: bail out entirely.
            sawUpstreamToolCall = true
            flushBuffered(controller)
            controller.enqueue(part)
            return
          case "text-start":
            if (phase === "passthrough") controller.enqueue(part)
            else if (phase === "sniff") buffered.push(part)
            // capture: drop (no visible text block)
            return
          case "text-delta": {
            if (phase === "passthrough") {
              controller.enqueue(part)
              return
            }
            if (phase === "capture") {
              capture += part.delta
              return
            }
            buffered.push(part)
            sniffText += part.delta
            decideSniff(controller)
            return
          }
          case "text-end":
            if (phase === "passthrough") controller.enqueue(part)
            else if (phase === "sniff") {
              // Block ended while still sniffing (short message): decide now.
              if (earliestMarker(sniffText) >= 0) {
                buffered = []
                phase = "capture"
                capture = sniffText
                sniffText = ""
              } else {
                buffered.push(part)
                flushBuffered(controller)
                phase = "passthrough"
              }
            }
            // capture: drop
            return
          case "finish": {
            finished = true
            if (phase === "capture" && capture) {
              const n = emitTools(controller, capture)
              if (n > 0) {
                controller.enqueue({
                  type: "finish",
                  usage: part.usage,
                  finishReason: { unified: "tool-calls" as const, raw: part.finishReason.raw },
                  providerMetadata: part.providerMetadata,
                })
                return
              }
              // Couldn't parse — fall back to surfacing whatever we withheld.
              flushBuffered(controller)
            } else {
              flushBuffered(controller)
            }
            controller.enqueue(part)
            return
          }
          default:
            // stream-start, response-metadata, reasoning-*, raw, error, etc.
            // Always forward immediately so `buffered` only ever holds text parts
            // (which are the only thing we may need to drop when a tool call wins).
            controller.enqueue(part)
        }
      },
      flush(controller) {
        if (finished || sawUpstreamToolCall) return
        if (phase === "capture" && capture) {
          if (emitTools(controller, capture) > 0) return
        }
        flushBuffered(controller)
      },
    })

    return { stream: stream.pipeThrough(transform), ...rest }
  },
}

/** Wrap a language model with tool-call content recovery. */
export function withToolCallRecovery(model: LanguageModelV3): LanguageModelV3 {
  return wrapLanguageModel({ model, middleware: toolCallRecoveryMiddleware })
}
