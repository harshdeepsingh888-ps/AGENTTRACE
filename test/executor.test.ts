import assert from "node:assert/strict";
import test from "node:test";

import { executeGraph } from "../src/modules/execution/executor";
import type {
  NodeExecutionInput,
  NodeOutput,
} from "../src/modules/execution/types";
import type { Graph } from "../src/modules/graph/types";
import { createNodeRunnerRegistry } from "../src/modules/nodes/registry";

const branchingGraph: Graph = {
  nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
  edges: [
    { from: "A", to: "B" },
    { from: "A", to: "C" },
    { from: "B", to: "D" },
    { from: "C", to: "D" },
  ],
};

function outputOf(nodeId: string): NodeOutput {
  return `${nodeId}-output`;
}

function registerEchoRunners(
  registry: ReturnType<typeof createNodeRunnerRegistry>,
  graph: Graph,
  calls: NodeExecutionInput[],
): void {
  for (const node of graph.nodes) {
    registry.registerNodeRunner(node.id, async (input) => {
      calls.push(input);
      return outputOf(node.id);
    });
  }
}

test("executes a linear A -> B -> C graph in order", async () => {
  const graph: Graph = {
    nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ],
  };

  const calls: NodeExecutionInput[] = [];
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, graph, calls);

  const result = await executeGraph(graph, registry);

  assert.equal(result.status, "success");
  assert.deepEqual(result.executionOrder, ["A", "B", "C"]);
  assert.deepEqual(
    calls.map((call) => call.nodeId),
    ["A", "B", "C"],
  );
});

test("executes a branching DAG in deterministic topological order", async () => {
  const calls: NodeExecutionInput[] = [];
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, branchingGraph, calls);

  const result = await executeGraph(branchingGraph, registry);

  assert.equal(result.status, "success");
  assert.deepEqual(result.executionOrder, ["A", "B", "C", "D"]);
});

test("root nodes receive empty parentOutputs", async () => {
  const calls: NodeExecutionInput[] = [];
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, branchingGraph, calls);

  await executeGraph(branchingGraph, registry);

  const rootCall = calls.find((call) => call.nodeId === "A");
  assert.ok(rootCall);
  assert.deepEqual(rootCall.parentOutputs, {});
});

test("a node receives outputs from direct parents only", async () => {
  const calls: NodeExecutionInput[] = [];
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, branchingGraph, calls);

  await executeGraph(branchingGraph, registry);

  const dCall = calls.find((call) => call.nodeId === "D");
  assert.ok(dCall);
  assert.deepEqual(dCall.parentOutputs, {
    B: outputOf("B"),
    C: outputOf("C"),
  });
  assert.equal(Object.prototype.hasOwnProperty.call(dCall.parentOutputs, "A"), false);
});

test("a child receives its parent's output", async () => {
  const graph: Graph = {
    nodes: [{ id: "A" }, { id: "B" }],
    edges: [{ from: "A", to: "B" }],
  };

  const calls: NodeExecutionInput[] = [];
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, graph, calls);

  await executeGraph(graph, registry);

  const bCall = calls.find((call) => call.nodeId === "B");
  assert.ok(bCall);
  assert.deepEqual(bCall.parentOutputs, { A: outputOf("A") });
});

test("each node executes exactly once", async () => {
  const callCounts = new Map<string, number>();
  const registry = createNodeRunnerRegistry();

  for (const node of branchingGraph.nodes) {
    registry.registerNodeRunner(node.id, async () => {
      callCounts.set(node.id, (callCounts.get(node.id) ?? 0) + 1);
      return outputOf(node.id);
    });
  }

  await executeGraph(branchingGraph, registry);

  for (const node of branchingGraph.nodes) {
    assert.equal(callCounts.get(node.id), 1);
  }
});

test("a missing runner fails descriptively", async () => {
  const graph: Graph = {
    nodes: [{ id: "A" }],
    edges: [],
  };

  const registry = createNodeRunnerRegistry();
  const result = await executeGraph(graph, registry);

  assert.equal(result.status, "failed");
  assert.equal(result.nodeResults.length, 1);
  const [aResult] = result.nodeResults;
  assert.equal(aResult.status, "failed");
  if (aResult.status === "failed") {
    assert.match(aResult.error.message, /No node runner registered for node id: A/);
  }
});

test("a node failure stops downstream execution", async () => {
  const calls: string[] = [];
  const registry = createNodeRunnerRegistry();

  registry.registerNodeRunner("A", async () => {
    calls.push("A");
    return outputOf("A");
  });
  registry.registerNodeRunner("B", async () => {
    calls.push("B");
    throw new Error("B blew up");
  });
  registry.registerNodeRunner("C", async () => {
    calls.push("C");
    return outputOf("C");
  });
  registry.registerNodeRunner("D", async () => {
    calls.push("D");
    return outputOf("D");
  });

  const result = await executeGraph(branchingGraph, registry);

  assert.equal(result.status, "failed");
  assert.deepEqual(calls, ["A", "B"]);
  assert.equal(result.nodeResults.length, 2);
  assert.equal(result.nodeResults[1].status, "failed");
});

test("failure result contains serializable error data, not an Error instance", async () => {
  const graph: Graph = {
    nodes: [{ id: "A" }],
    edges: [],
  };

  const registry = createNodeRunnerRegistry();
  registry.registerNodeRunner("A", async () => {
    throw new TypeError("boom");
  });

  const result = await executeGraph(graph, registry);
  const [aResult] = result.nodeResults;

  assert.equal(aResult.status, "failed");
  if (aResult.status === "failed") {
    assert.equal(aResult.error instanceof Error, false);
    assert.equal(aResult.error.name, "TypeError");
    assert.equal(aResult.error.message, "boom");
    assert.deepEqual(JSON.parse(JSON.stringify(aResult.error)), {
      name: "TypeError",
      message: "boom",
    });
  }
});

test("node results include timing fields", async () => {
  const graph: Graph = {
    nodes: [{ id: "A" }],
    edges: [],
  };

  const registry = createNodeRunnerRegistry();
  registry.registerNodeRunner("A", async () => outputOf("A"));

  const result = await executeGraph(graph, registry);
  const [aResult] = result.nodeResults;

  assert.equal(typeof aResult.startedAt, "string");
  assert.equal(typeof aResult.completedAt, "string");
  assert.equal(typeof aResult.durationMs, "number");
  assert.ok(!Number.isNaN(Date.parse(aResult.startedAt)));
  assert.ok(!Number.isNaN(Date.parse(aResult.completedAt)));
  assert.ok(aResult.durationMs >= 0);
});

test("disconnected nodes all execute", async () => {
  const graph: Graph = {
    nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
    edges: [{ from: "A", to: "B" }],
  };

  const calls: NodeExecutionInput[] = [];
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, graph, calls);

  const result = await executeGraph(graph, registry);

  assert.equal(result.status, "success");
  assert.deepEqual(
    new Set(calls.map((call) => call.nodeId)),
    new Set(["A", "B", "C"]),
  );
});

test("a cyclic graph is rejected before any runner executes", async () => {
  const graph: Graph = {
    nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
      { from: "C", to: "A" },
    ],
  };

  const calls: string[] = [];
  const registry = createNodeRunnerRegistry();
  for (const node of graph.nodes) {
    registry.registerNodeRunner(node.id, async () => {
      calls.push(node.id);
      return outputOf(node.id);
    });
  }

  await assert.rejects(
    () => executeGraph(graph, registry),
    /Graph contains a cycle/,
  );
  assert.deepEqual(calls, []);
});
