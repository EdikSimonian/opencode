/**
 * Render a finished workflow run into the compact, parseable text block that
 * becomes the tool result the model reads. Truncation of oversized output is
 * handled upstream by the tool wrapper, so this just structures the content.
 */
import type { StepResult } from "./ir"

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Attribute values are model-controlled (id/label/agentType come from the
// workflow doc), so also escape quotes to keep the block well-formed.
function escapeAttr(value: string): string {
  return escape(value).replace(/"/g, "&quot;")
}

function renderStep(step: StepResult): string {
  const body =
    step.json !== undefined
      ? ["<json>", escape(JSON.stringify(step.json, null, 2)), "</json>"]
      : ["<result>", escape(step.text), "</result>"]
  return [
    `<step id="${escapeAttr(step.nodeID)}" label="${escapeAttr(step.label)}" agent="${escapeAttr(step.agentType)}" state="${step.status}">`,
    ...body,
    "</step>",
  ].join("\n")
}

export function formatWorkflowOutput(input: { runID: string; status: string; results: StepResult[] }): string {
  return [
    `<workflow id="${input.runID}" state="${input.status}" steps="${input.results.length}">`,
    ...input.results.map(renderStep),
    "</workflow>",
  ].join("\n")
}
