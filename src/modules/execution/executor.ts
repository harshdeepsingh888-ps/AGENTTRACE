import type { Graph, NodeId } from "../graph/types";
import { topologicalSort, validateGraph } from "../graph/graph";
import type { NodeRunnerRegistry } from "../nodes/registry";
import type {
  ExecutionResult,
  NodeExecutionInput,
  NodeExecutionResult,
  NodeExecutionStatus,
  NodeOutput,
  SerializableError,
} from "./types";

function buildDirectParents(graph: Graph): Map<NodeId, NodeId[]> {
  const directParents = new Map<NodeId, NodeId[]>();

  for (const node of graph.nodes) {
    directParents.set(node.id, []);
  }

  for (const edge of graph.edges) {
    directParents.get(edge.to)?.push(edge.from);
  }

  return directParents;
}

function normalizeError(error: unknown): SerializableError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { message: String(error) };
}

function getParentOutput(
  outputs: Map<NodeId, NodeOutput>,
  parentId: NodeId,
): NodeOutput {
  if (!outputs.has(parentId)) {
    throw new Error(`Missing output for parent node: ${parentId}`);
  }

  return outputs.get(parentId) as NodeOutput;
}

export async function executeGraph(
  graph: Graph,
  registry: NodeRunnerRegistry,
): Promise<ExecutionResult> {
  validateGraph(graph);
  const executionOrder = topologicalSort(graph);
  const directParents = buildDirectParents(graph);
  const outputs = new Map<NodeId, NodeOutput>();
  const nodeResults: NodeExecutionResult[] = [];
  let status: NodeExecutionStatus = "success";

  for (const nodeId of executionOrder) {
    const parentOutputs: Record<NodeId, NodeOutput> = {};
    for (const parentId of directParents.get(nodeId) ?? []) {
      parentOutputs[parentId] = getParentOutput(outputs, parentId);
    }

    const input: NodeExecutionInput = { nodeId, parentOutputs };
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();

    try {
      const runner = registry.getNodeRunner(nodeId);
      const output = await runner(input);
      const completedAtMs = Date.now();
      const completedAt = new Date(completedAtMs).toISOString();

      outputs.set(nodeId, output);
      nodeResults.push({
        nodeId,
        status: "success",
        input,
        output,
        startedAt,
        completedAt,
        durationMs: completedAtMs - startedAtMs,
      });
    } catch (error) {
      const completedAtMs = Date.now();
      const completedAt = new Date(completedAtMs).toISOString();

      nodeResults.push({
        nodeId,
        status: "failed",
        input,
        error: normalizeError(error),
        startedAt,
        completedAt,
        durationMs: completedAtMs - startedAtMs,
      });
      status = "failed";
      break;
    }
  }

  return { executionOrder, nodeResults, status };
}
