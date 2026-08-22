import type { Graph, NodeId } from "./types";

interface GraphIndex {
  nodeIds: NodeId[];
  nodeIdSet: Set<NodeId>;
  adjacency: Map<NodeId, NodeId[]>;
  reverseAdjacency: Map<NodeId, NodeId[]>;
  indegrees: Map<NodeId, number>;
}

function buildGraphIndex(graph: Graph): GraphIndex {
  const nodeIds: NodeId[] = [];
  const nodeIdSet = new Set<NodeId>();
  const adjacency = new Map<NodeId, NodeId[]>();
  const reverseAdjacency = new Map<NodeId, NodeId[]>();
  const indegrees = new Map<NodeId, number>();

  for (const node of graph.nodes) {
    if (nodeIdSet.has(node.id)) {
      throw new Error(`Duplicate node id: ${node.id}`);
    }

    nodeIds.push(node.id);
    nodeIdSet.add(node.id);
    adjacency.set(node.id, []);
    reverseAdjacency.set(node.id, []);
    indegrees.set(node.id, 0);
  }

  for (const edge of graph.edges) {
    const outgoing = adjacency.get(edge.from);
    if (outgoing === undefined) {
      throw new Error(`Edge references unknown source node: ${edge.from}`);
    }

    const incoming = reverseAdjacency.get(edge.to);
    const targetIndegree = indegrees.get(edge.to);
    if (incoming === undefined || targetIndegree === undefined) {
      throw new Error(`Edge references unknown target node: ${edge.to}`);
    }

    if (edge.from === edge.to) {
      throw new Error(`Self-referencing edge is not allowed: ${edge.from}`);
    }

    outgoing.push(edge.to);
    incoming.push(edge.from);
    indegrees.set(edge.to, targetIndegree + 1);
  }

  return {
    nodeIds,
    nodeIdSet,
    adjacency,
    reverseAdjacency,
    indegrees,
  };
}

function sortGraphIndex(graphIndex: GraphIndex): NodeId[] {
  const indegrees = new Map(graphIndex.indegrees);
  const ready: NodeId[] = [];

  for (const nodeId of graphIndex.nodeIds) {
    if (indegrees.get(nodeId) === 0) {
      ready.push(nodeId);
    }
  }

  const sorted: NodeId[] = [];
  let readyIndex = 0;

  while (readyIndex < ready.length) {
    const nodeId = ready[readyIndex];
    readyIndex += 1;
    sorted.push(nodeId);

    const children = graphIndex.adjacency.get(nodeId);
    if (children === undefined) {
      throw new Error(`Graph contains unknown node: ${nodeId}`);
    }

    for (const childId of children) {
      const childIndegree = indegrees.get(childId);
      if (childIndegree === undefined) {
        throw new Error(`Graph contains unknown node: ${childId}`);
      }

      const nextIndegree = childIndegree - 1;
      indegrees.set(childId, nextIndegree);

      if (nextIndegree === 0) {
        ready.push(childId);
      }
    }
  }

  if (sorted.length !== graphIndex.nodeIds.length) {
    throw new Error("Graph contains a cycle");
  }

  return sorted;
}

function createValidatedGraphIndex(graph: Graph): GraphIndex {
  const graphIndex = buildGraphIndex(graph);
  sortGraphIndex(graphIndex);
  return graphIndex;
}

function assertNodeExists(graphIndex: GraphIndex, nodeId: NodeId): void {
  if (!graphIndex.nodeIdSet.has(nodeId)) {
    throw new Error(`Graph does not contain node: ${nodeId}`);
  }
}

function collectReachableNodes(
  adjacency: Map<NodeId, NodeId[]>,
  nodeId: NodeId,
): Set<NodeId> {
  const reachable = new Set<NodeId>();
  const pending = [...(adjacency.get(nodeId) ?? [])];

  while (pending.length > 0) {
    const currentNodeId = pending.pop();
    if (currentNodeId === undefined || reachable.has(currentNodeId)) {
      continue;
    }

    reachable.add(currentNodeId);

    const connectedNodes = adjacency.get(currentNodeId);
    if (connectedNodes !== undefined) {
      for (const connectedNodeId of connectedNodes) {
        pending.push(connectedNodeId);
      }
    }
  }

  return reachable;
}

export function validateGraph(graph: Graph): void {
  createValidatedGraphIndex(graph);
}

export function topologicalSort(graph: Graph): NodeId[] {
  return sortGraphIndex(buildGraphIndex(graph));
}

export function getAncestors(graph: Graph, nodeId: NodeId): Set<NodeId> {
  const graphIndex = createValidatedGraphIndex(graph);
  assertNodeExists(graphIndex, nodeId);
  return collectReachableNodes(graphIndex.reverseAdjacency, nodeId);
}

export function getDescendants(graph: Graph, nodeId: NodeId): Set<NodeId> {
  const graphIndex = createValidatedGraphIndex(graph);
  assertNodeExists(graphIndex, nodeId);
  return collectReachableNodes(graphIndex.adjacency, nodeId);
}
