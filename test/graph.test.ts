import assert from "node:assert/strict";
import test from "node:test";

import {
  getAncestors,
  getDescendants,
  topologicalSort,
  validateGraph,
} from "../src/modules/graph/graph";
import type { Graph, NodeId } from "../src/modules/graph/types";

const branchingGraph: Graph = {
  nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
  edges: [
    { from: "A", to: "B" },
    { from: "A", to: "C" },
    { from: "B", to: "D" },
    { from: "C", to: "D" },
  ],
};

function assertParentBeforeChild(
  sortedNodeIds: NodeId[],
  parentId: NodeId,
  childId: NodeId,
): void {
  assert.ok(sortedNodeIds.indexOf(parentId) < sortedNodeIds.indexOf(childId));
}

test("topologically sorts a linear DAG", () => {
  const graph: Graph = {
    nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ],
  };

  assert.deepEqual(topologicalSort(graph), ["A", "B", "C"]);
});

test("topologically sorts a branching DAG", () => {
  const sorted = topologicalSort(branchingGraph);

  assert.deepEqual(sorted, ["A", "B", "C", "D"]);
  assertParentBeforeChild(sorted, "A", "B");
  assertParentBeforeChild(sorted, "A", "C");
  assertParentBeforeChild(sorted, "B", "D");
  assertParentBeforeChild(sorted, "C", "D");
});

test("returns all transitive ancestors", () => {
  assert.deepEqual(
    [...getAncestors(branchingGraph, "D")].sort(),
    ["A", "B", "C"],
  );
});

test("returns all transitive descendants", () => {
  assert.deepEqual(
    [...getDescendants(branchingGraph, "A")].sort(),
    ["B", "C", "D"],
  );
});

test("includes disconnected nodes in a topological sort", () => {
  const graph: Graph = {
    nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
    edges: [{ from: "A", to: "B" }],
  };

  const sorted = topologicalSort(graph);
  assert.deepEqual(new Set(sorted), new Set(["A", "B", "C"]));
  assertParentBeforeChild(sorted, "A", "B");
});

test("rejects a cycle", () => {
  const graph: Graph = {
    nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
      { from: "C", to: "A" },
    ],
  };

  assert.throws(() => validateGraph(graph), /Graph contains a cycle/);
  assert.throws(() => topologicalSort(graph), /Graph contains a cycle/);
});

test("rejects an unknown edge source", () => {
  const graph: Graph = {
    nodes: [{ id: "A" }],
    edges: [{ from: "X", to: "A" }],
  };

  assert.throws(
    () => validateGraph(graph),
    /Edge references unknown source node: X/,
  );
});

test("rejects an unknown edge target", () => {
  const graph: Graph = {
    nodes: [{ id: "A" }],
    edges: [{ from: "A", to: "X" }],
  };

  assert.throws(
    () => validateGraph(graph),
    /Edge references unknown target node: X/,
  );
});

test("rejects duplicate node IDs", () => {
  const graph: Graph = {
    nodes: [{ id: "A" }, { id: "A" }],
    edges: [],
  };

  assert.throws(() => validateGraph(graph), /Duplicate node id: A/);
});

test("rejects self-referencing edges", () => {
  const graph: Graph = {
    nodes: [{ id: "A" }],
    edges: [{ from: "A", to: "A" }],
  };

  assert.throws(
    () => validateGraph(graph),
    /Self-referencing edge is not allowed: A/,
  );
});

test("rejects an unknown node when finding ancestors", () => {
  assert.throws(
    () => getAncestors(branchingGraph, "X"),
    /Graph does not contain node: X/,
  );
});

test("rejects an unknown node when finding descendants", () => {
  assert.throws(
    () => getDescendants(branchingGraph, "X"),
    /Graph does not contain node: X/,
  );
});
