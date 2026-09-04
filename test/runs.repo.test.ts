import assert from "node:assert/strict";
import test from "node:test";

import { buildNodeResultInsertParams } from "../src/modules/runs/runs.repo";
import type { NodeExecutionResult } from "../src/modules/execution/types";

function successResult(
  overrides: Partial<Extract<NodeExecutionResult, { status: "success" }>> = {},
): NodeExecutionResult {
  return {
    nodeId: "A",
    status: "success",
    input: { nodeId: "A", parentOutputs: {} },
    output: "A-output",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.010Z",
    durationMs: 10,
    ...overrides,
  };
}

function failureResult(
  overrides: Partial<Extract<NodeExecutionResult, { status: "failed" }>> = {},
): NodeExecutionResult {
  return {
    nodeId: "B",
    status: "failed",
    input: { nodeId: "B", parentOutputs: { A: "A-output" } },
    error: { name: "Error", message: "boom" },
    startedAt: "2026-01-01T00:00:01.000Z",
    completedAt: "2026-01-01T00:00:01.005Z",
    durationMs: 5,
    ...overrides,
  };
}

test("a successful node result serializes its output and leaves error as SQL NULL", () => {
  const params = buildNodeResultInsertParams("run-1", successResult());

  assert.equal(params.status, "success");
  assert.equal(params.output, JSON.stringify("A-output"));
  assert.equal(params.error, null);
});

test("a successful JSON null output is serialized as JSON text 'null', not SQL NULL", () => {
  const params = buildNodeResultInsertParams("run-1", successResult({ output: null }));

  assert.equal(params.output, "null");
  assert.notEqual(params.output, null);
});

test("a failed node result serializes its error and leaves output as SQL NULL", () => {
  const params = buildNodeResultInsertParams("run-1", failureResult());

  assert.equal(params.status, "failed");
  assert.equal(params.output, null);
  assert.equal(params.error, JSON.stringify({ name: "Error", message: "boom" }));
});

test("root node input is persisted with empty parentOutputs", () => {
  const params = buildNodeResultInsertParams(
    "run-1",
    successResult({ input: { nodeId: "A", parentOutputs: {} } }),
  );

  assert.deepEqual(JSON.parse(params.input), { nodeId: "A", parentOutputs: {} });
});

test("child node input is persisted with only its direct parent outputs", () => {
  const params = buildNodeResultInsertParams(
    "run-1",
    successResult({
      nodeId: "D",
      input: {
        nodeId: "D",
        parentOutputs: { B: "B-output", C: "C-output" },
      },
    }),
  );

  assert.deepEqual(JSON.parse(params.input), {
    nodeId: "D",
    parentOutputs: { B: "B-output", C: "C-output" },
  });
});

test("timing fields are passed through unchanged from the executor result", () => {
  const result = successResult({
    startedAt: "2026-02-02T10:00:00.000Z",
    completedAt: "2026-02-02T10:00:00.250Z",
    durationMs: 250,
  });

  const params = buildNodeResultInsertParams("run-1", result);

  assert.equal(params.startedAt, "2026-02-02T10:00:00.000Z");
  assert.equal(params.completedAt, "2026-02-02T10:00:00.250Z");
  assert.equal(params.durationMs, 250);
});
