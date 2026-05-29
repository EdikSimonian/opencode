import { describe, expect, test } from "bun:test"
import { compile, CompileError } from "@/workflow/compile"
import type { IR } from "@/workflow/ir"

describe("workflow compile (valid documents)", () => {
  test("single agent step collapses to a single agent node", () => {
    const { ir } = compile({ steps: [{ type: "agent", agent: "general", prompt: "do it" }] })
    expect(ir.kind).toBe("agent")
    if (ir.kind !== "agent") throw new Error("unreachable")
    expect(ir.agentType).toBe("general")
    expect(ir.prompt).toBe("do it")
    expect(ir.id).toBe("step1")
  })

  test("multiple top-level steps become an implicit seq", () => {
    const { ir } = compile({
      steps: [
        { type: "agent", agent: "a", prompt: "one" },
        { type: "agent", agent: "b", prompt: "two" },
      ],
    })
    expect(ir.kind).toBe("seq")
    if (ir.kind !== "seq") throw new Error("unreachable")
    expect(ir.children).toHaveLength(2)
  })

  test("parallel and nested seq compile recursively", () => {
    const { ir } = compile({
      steps: [
        {
          type: "parallel",
          steps: [
            { type: "agent", agent: "a", prompt: "x" },
            { type: "seq", steps: [{ type: "agent", agent: "b", prompt: "y" }] },
          ],
        },
      ],
    })
    expect(ir.kind).toBe("parallel")
    if (ir.kind !== "parallel") throw new Error("unreachable")
    expect(ir.children[0]!.kind).toBe("agent")
    expect(ir.children[1]!.kind).toBe("seq")
  })

  test("respects explicit ids, labels, phase and schema", () => {
    const { ir } = compile({
      steps: [
        {
          type: "agent",
          agent: "reviewer",
          prompt: "review",
          id: "rev",
          label: "Review pass",
          phase: "Verify",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      ],
    }) as { ir: Extract<IR, { kind: "agent" }> }
    expect(ir.id).toBe("rev")
    expect(ir.label).toBe("Review pass")
    expect(ir.phase).toBe("Verify")
    expect(ir.schema).toEqual({ type: "object", properties: { ok: { type: "boolean" } } })
  })

  test("auto-generated ids avoid collisions with explicit ids", () => {
    const { ir } = compile({
      steps: [
        { type: "agent", agent: "a", prompt: "x", id: "step1" },
        { type: "agent", agent: "b", prompt: "y" },
      ],
    })
    if (ir.kind !== "seq") throw new Error("unreachable")
    const ids = ir.children.map((c) => (c.kind === "agent" ? c.id : ""))
    expect(new Set(ids).size).toBe(2)
    expect(ids).toContain("step1")
  })

  test("log steps compile and parse concurrency", () => {
    const { ir, concurrency } = compile({
      concurrency: 4,
      steps: [
        { type: "log", message: "begin" },
        { type: "agent", agent: "a", prompt: "x" },
      ],
    })
    expect(concurrency).toBe(4)
    if (ir.kind !== "seq") throw new Error("unreachable")
    expect(ir.children[0]).toEqual({ kind: "log", message: "begin" })
  })
})

describe("workflow compile (invalid documents)", () => {
  const cases: Array<[string, unknown]> = [
    ["non-object input", 42],
    ["missing steps", {}],
    ["empty steps", { steps: [] }],
    ["step not an object", { steps: [5] }],
    ["unknown step type", { steps: [{ type: "frobnicate" }] }],
    ["agent missing agent type", { steps: [{ type: "agent", prompt: "x" }] }],
    ["agent missing prompt", { steps: [{ type: "agent", agent: "a" }] }],
    ["agent empty prompt", { steps: [{ type: "agent", agent: "a", prompt: "  " }] }],
    ["log missing message", { steps: [{ type: "log" }] }],
    ["parallel empty children", { steps: [{ type: "parallel", steps: [] }] }],
    ["seq steps not array", { steps: [{ type: "seq", steps: "nope" }] }],
    [
      "duplicate explicit ids",
      {
        steps: [
          { type: "agent", agent: "a", prompt: "x", id: "dup" },
          { type: "agent", agent: "b", prompt: "y", id: "dup" },
        ],
      },
    ],
    ["non-integer concurrency", { concurrency: 1.5, steps: [{ type: "agent", agent: "a", prompt: "x" }] }],
    ["zero concurrency", { concurrency: 0, steps: [{ type: "agent", agent: "a", prompt: "x" }] }],
    ["schema not an object", { steps: [{ type: "agent", agent: "a", prompt: "x", schema: "no" }] }],
  ]

  for (const [name, doc] of cases) {
    test(`rejects: ${name}`, () => {
      expect(() => compile(doc)).toThrow(CompileError)
    })
  }
})
