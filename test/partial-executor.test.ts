import assert from "node:assert/strict";
import test from "node:test";

import { executeGraphFromNode } from "../src/modules/execution/partial-executor";
import type {
  NodeExecutionInput,
  NodeOutput,
} from "../src/modules/execution/types";
import type { Graph } from "../src/modules/graph/types";
import { createNodeRunnerRegistry } from "../src/modules/nodes/registry";

function outputOf(nodeId: string): NodeOutput {
  return `${nodeId}-output`;
}

function registerEchoRunners(
  registry: ReturnType<typeof createNodeRunnerRegistry>,
  graph: Graph,
  calls: NodeExecutionInput[] = [],
): void {
  for (const node of graph.nodes) {
    registry.registerNodeRunner(node.id, async (input) => {
      calls.push(input);
      return outputOf(node.id);
    });
  }
}

const linearGraph: Graph = {
  nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
  edges: [
    { from: "A", to: "B" },
    { from: "B", to: "C" },
  ],
};

const linearGraphWithDisconnectedNode: Graph = {
  nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "X" }],
  edges: [
    { from: "A", to: "B" },
    { from: "B", to: "C" },
  ],
};

const graphWithDownstreamAndDisconnectedNode: Graph = {
  nodes: [
    { id: "A" },
    { id: "B" },
    { id: "C" },
    { id: "D" },
    { id: "E" },
    { id: "X" },
  ],
  edges: [
    { from: "A", to: "B" },
    { from: "A", to: "C" },
    { from: "B", to: "D" },
    { from: "C", to: "D" },
    { from: "D", to: "E" },
  ],
};

const branchingGraph: Graph = {
  nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
  edges: [
    { from: "A", to: "B" },
    { from: "A", to: "C" },
    { from: "B", to: "D" },
    { from: "C", to: "D" },
  ],
};

test("1. linear graph rerun from middle: A -> B -> C, target B, cached A, executes B,C", async () => {
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, linearGraph);

  const result = await executeGraphFromNode(linearGraph, "B", registry, {
    A: outputOf("A"),
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.executionOrder, ["B", "C"]);
  assert.deepEqual(result.cachedNodeIds, ["A"]);
  assert.deepEqual(
    result.nodeResults.map((r) => r.nodeId),
    ["B", "C"],
  );
});

test("2. rerun from root executes the whole graph with an empty cached set", async () => {
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, linearGraph);

  const result = await executeGraphFromNode(linearGraph, "A", registry, {});

  assert.equal(result.status, "success");
  assert.deepEqual(result.executionOrder, ["A", "B", "C"]);
  assert.deepEqual(result.cachedNodeIds, []);
});

test("3. rerun from leaf: ancestors cached, only the leaf executes", async () => {
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, linearGraph);

  const result = await executeGraphFromNode(linearGraph, "C", registry, {
    A: outputOf("A"),
    B: outputOf("B"),
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.executionOrder, ["C"]);
  assert.deepEqual(result.cachedNodeIds, ["A", "B"]);
});

test("4. branching rerun from D: A/B/C cached, only D executes", async () => {
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, branchingGraph);

  const result = await executeGraphFromNode(branchingGraph, "D", registry, {
    A: outputOf("A"),
    B: outputOf("B"),
    C: outputOf("C"),
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.executionOrder, ["D"]);
  assert.deepEqual(result.cachedNodeIds, ["A", "B", "C"]);
});

test("5. critical mixed fresh/cache dependency: target B, D receives fresh B and cached C", async () => {
  const registry = createNodeRunnerRegistry();
  const calls: NodeExecutionInput[] = [];
  registerEchoRunners(registry, branchingGraph, calls);

  const result = await executeGraphFromNode(branchingGraph, "B", registry, {
    A: outputOf("A"),
    C: "cached-C-output",
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.executionOrder, ["B", "D"]);
  assert.deepEqual(result.cachedNodeIds, ["A", "C"]);

  const dCall = calls.find((call) => call.nodeId === "D");
  assert.ok(dCall);
  assert.deepEqual(dCall.parentOutputs, {
    B: outputOf("B"),
    C: "cached-C-output",
  });
});

test("6. an unrelated node does not execute", async () => {
  const registry = createNodeRunnerRegistry();
  const calls: NodeExecutionInput[] = [];
  registerEchoRunners(registry, branchingGraph, calls);

  await executeGraphFromNode(branchingGraph, "B", registry, {
    A: outputOf("A"),
    C: outputOf("C"),
  });

  assert.equal(calls.some((call) => call.nodeId === "C"), false);
});

test("7. a cached parent output of JSON null is accepted", async () => {
  const registry = createNodeRunnerRegistry();
  const calls: NodeExecutionInput[] = [];
  registerEchoRunners(registry, linearGraph, calls);

  const result = await executeGraphFromNode(linearGraph, "B", registry, {
    A: null,
  });

  assert.equal(result.status, "success");
  const bCall = calls.find((call) => call.nodeId === "B");
  assert.ok(bCall);
  assert.deepEqual(bCall.parentOutputs, { A: null });
});

test("8. a cached parent output of false is accepted", async () => {
  const registry = createNodeRunnerRegistry();
  const calls: NodeExecutionInput[] = [];
  registerEchoRunners(registry, linearGraph, calls);

  await executeGraphFromNode(linearGraph, "B", registry, { A: false });

  const bCall = calls.find((call) => call.nodeId === "B");
  assert.ok(bCall);
  assert.deepEqual(bCall.parentOutputs, { A: false });
});

test("9. a cached parent output of 0 is accepted", async () => {
  const registry = createNodeRunnerRegistry();
  const calls: NodeExecutionInput[] = [];
  registerEchoRunners(registry, linearGraph, calls);

  await executeGraphFromNode(linearGraph, "B", registry, { A: 0 });

  const bCall = calls.find((call) => call.nodeId === "B");
  assert.ok(bCall);
  assert.deepEqual(bCall.parentOutputs, { A: 0 });
});

test('10. a cached parent output of "" is accepted', async () => {
  const registry = createNodeRunnerRegistry();
  const calls: NodeExecutionInput[] = [];
  registerEchoRunners(registry, linearGraph, calls);

  await executeGraphFromNode(linearGraph, "B", registry, { A: "" });

  const bCall = calls.find((call) => call.nodeId === "B");
  assert.ok(bCall);
  assert.deepEqual(bCall.parentOutputs, { A: "" });
});

test("11. a missing cached dependency fails descriptively", async () => {
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, branchingGraph);

  await assert.rejects(
    () => executeGraphFromNode(branchingGraph, "B", registry, { A: outputOf("A") }),
    /Missing cached output for parent "C" required by rerun node "D"/,
  );
});

test("12. a failed executed node stops downstream rerun execution", async () => {
  const registry = createNodeRunnerRegistry();
  registry.registerNodeRunner("B", async () => {
    throw new Error("B blew up");
  });
  registry.registerNodeRunner("D", async () => outputOf("D"));

  const result = await executeGraphFromNode(branchingGraph, "B", registry, {
    A: outputOf("A"),
    C: outputOf("C"),
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(
    result.nodeResults.map((r) => r.nodeId),
    ["B"],
  );
  assert.equal(result.nodeResults[0].status, "failed");
});

test("13. a missing runner becomes a failed rerun result, consistent with the full executor", async () => {
  const registry = createNodeRunnerRegistry();
  // No runner registered for B at all.

  const result = await executeGraphFromNode(linearGraph, "B", registry, {
    A: outputOf("A"),
  });

  assert.equal(result.status, "failed");
  const [bResult] = result.nodeResults;
  assert.equal(bResult.status, "failed");
  if (bResult.status === "failed") {
    assert.match(bResult.error.message, /No node runner registered for node id: B/);
  }
});

test("14. executing nodes receive direct parent outputs only", async () => {
  const registry = createNodeRunnerRegistry();
  const calls: NodeExecutionInput[] = [];
  registerEchoRunners(registry, branchingGraph, calls);

  await executeGraphFromNode(branchingGraph, "B", registry, {
    A: outputOf("A"),
    C: outputOf("C"),
  });

  const dCall = calls.find((call) => call.nodeId === "D");
  assert.ok(dCall);
  assert.equal(Object.prototype.hasOwnProperty.call(dCall.parentOutputs, "A"), false);
});

test("15. a nonexistent target node fails clearly", async () => {
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, linearGraph);

  await assert.rejects(
    () => executeGraphFromNode(linearGraph, "X", registry, {}),
    /Graph does not contain node: X/,
  );
});

test("16. a cyclic graph is rejected before any node executes", async () => {
  const cyclicGraph: Graph = {
    nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
      { from: "C", to: "A" },
    ],
  };
  const registry = createNodeRunnerRegistry();
  const calls: string[] = [];
  for (const node of cyclicGraph.nodes) {
    registry.registerNodeRunner(node.id, async () => {
      calls.push(node.id);
      return outputOf(node.id);
    });
  }

  await assert.rejects(
    () => executeGraphFromNode(cyclicGraph, "B", registry, { A: outputOf("A") }),
    /Graph contains a cycle/,
  );
  assert.deepEqual(calls, []);
});

test("A. a disconnected unrelated node is not in cachedNodeIds", async () => {
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, linearGraphWithDisconnectedNode);

  const result = await executeGraphFromNode(
    linearGraphWithDisconnectedNode,
    "B",
    registry,
    { A: outputOf("A") },
  );

  assert.deepEqual(result.cachedNodeIds, ["A"]);
  assert.equal(result.cachedNodeIds.includes("X"), false);
});

test("B. rerun from D reports A/B/C as cached, not the disconnected X", async () => {
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, graphWithDownstreamAndDisconnectedNode);

  const result = await executeGraphFromNode(
    graphWithDownstreamAndDisconnectedNode,
    "D",
    registry,
    { A: outputOf("A"), B: outputOf("B"), C: outputOf("C") },
  );

  assert.equal(result.status, "success");
  assert.deepEqual(result.executionOrder, ["D", "E"]);
  assert.deepEqual(result.cachedNodeIds, ["A", "B", "C"]);
  assert.equal(result.cachedNodeIds.includes("X"), false);
});

test("C. rerun from B reports A/C as cached (not B's own descendant-only dependency C), not the disconnected X", async () => {
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, graphWithDownstreamAndDisconnectedNode);

  const result = await executeGraphFromNode(
    graphWithDownstreamAndDisconnectedNode,
    "B",
    registry,
    { A: outputOf("A"), C: outputOf("C") },
  );

  assert.equal(result.status, "success");
  assert.deepEqual(result.executionOrder, ["B", "D", "E"]);
  assert.deepEqual(result.cachedNodeIds, ["A", "C"]);
  assert.equal(result.cachedNodeIds.includes("X"), false);
});
