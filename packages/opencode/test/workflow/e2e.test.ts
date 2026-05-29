import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { it } from "../lib/effect"
import { compile } from "@/workflow/compile"
import { interpret } from "@/workflow/interpreter"
import { makeFakeRunner } from "@/workflow/runner"
import { formatWorkflowOutput } from "@/workflow/format"

describe("workflow end-to-end (compile -> interpret -> format)", () => {
  it.live("runs a mixed seq/parallel document and renders output", () =>
    Effect.gen(function* () {
      const { ir, concurrency } = compile({
        concurrency: 2,
        steps: [
          { type: "log", message: "starting" },
          {
            type: "parallel",
            steps: [
              { type: "agent", id: "x", agent: "general", prompt: "do x" },
              { type: "agent", id: "y", agent: "general", prompt: "do y" },
            ],
          },
          { type: "agent", id: "sum", agent: "general", prompt: "summarize", schema: { type: "object" } },
        ],
      })
      const runner = yield* makeFakeRunner({
        behaviors: { sum: { json: { done: true }, text: "summary" } },
        default: { delayMillis: 5 },
      })
      const results = yield* interpret({ runID: "wf_e2e", node: ir, runner, concurrency })
      expect(results.map((r) => r.nodeID).sort()).toEqual(["sum", "x", "y"])

      const output = formatWorkflowOutput({ runID: "wf_e2e", status: "completed", results })
      expect(output).toContain('<workflow id="wf_e2e" state="completed" steps="3">')
      expect(output).toContain('id="x"')
      expect(output).toContain('id="sum"')
      expect(output).toContain('"done": true')
    }),
  )
})

describe("formatWorkflowOutput", () => {
  test("renders text results and escapes angle brackets", () => {
    const out = formatWorkflowOutput({
      runID: "wf_1",
      status: "completed",
      results: [
        {
          stepID: "wfs_1",
          nodeID: "a",
          label: "A",
          agentType: "general",
          status: "completed",
          text: "1 < 2 && 3 > 2",
        },
      ],
    })
    expect(out).toContain('<step id="a" label="A" agent="general" state="completed">')
    expect(out).toContain("1 &lt; 2 &amp;&amp; 3 &gt; 2")
    expect(out).toContain("<result>")
  })

  test("renders json results when present", () => {
    const out = formatWorkflowOutput({
      runID: "wf_2",
      status: "completed",
      results: [
        {
          stepID: "wfs_1",
          nodeID: "a",
          label: "A",
          agentType: "general",
          status: "completed",
          text: "ignored",
          json: { ok: 1 },
        },
      ],
    })
    expect(out).toContain("<json>")
    expect(out).toContain('"ok": 1')
    expect(out).not.toContain("<result>")
  })
})
