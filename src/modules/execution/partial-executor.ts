import type { Graph, NodeId } from "../graph/types";
import { getAncestors, getDescendants, topologicalSort, validateGraph } from "../graph/graph";
import type { NodeRunnerRegistry } from "../nodes/registry";
import { buildDirectParents, normalizeError } from "./executor";
import type {
  NodeExecutionInput,
  NodeExecutionResult,
  NodeExecutionStatus,
  NodeOutput,
  PartialExecutionResult,
} from "./types";

/**
 * The "cached dependency context" for a rerun: every node that a node in
 * the execution set actually depends on (directly or transitively) but
 * that is not itself executing. This is the union of getAncestors(...)
 * over every node in the execution set, minus the execution set itself -
 * NOT simply "every node outside the execution set", which would wrongly
 * sweep in disconnected/unrelated nodes that this rerun never touches.
 *
 * Using ancestors of the whole execution set (not just the target) is
 * what correctly captures a case like: rerun from B where D (a descendant
 * of B, so also executing) still depends on sibling branch C - C is an
 * ancestor of D, not of B, so it would be missed if we only looked at the
 * target's own ancestors.
 */
function computeCachedDependencyNodeIds(
  graph: Graph,
  executionSet: Set<NodeId>,
  fullOrder: NodeId[],
): NodeId[] {
  const cachedDependencySet = new Set<NodeId>();

  for (const nodeId of executionSet) {
    for (const ancestorId of getAncestors(graph, nodeId)) {
      if (!executionSet.has(ancestorId)) {
        cachedDependencySet.add(ancestorId);
      }
    }
  }

  return fullOrder.filter((nodeId) => cachedDependencySet.has(nodeId));
}

function assertRequiredCacheIsAvailable(
  executionSet: Set<NodeId>,
  directParents: Map<NodeId, NodeId[]>,
  cachedOutputs: Record<NodeId, NodeOutput>,
): void {
  for (const nodeId of executionSet) {
    for (const parentId of directParents.get(nodeId) ?? []) {
      if (executionSet.has(parentId)) {
        // This parent re-executes earlier in the same rerun (topological
        // order guarantees it runs first) and will supply a fresh output.
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(cachedOutputs, parentId)) {
        throw new Error(
          `Missing cached output for parent "${parentId}" required by rerun node "${nodeId}"`,
        );
      }
    }
  }
}

function resolveParentOutputs(
  nodeId: NodeId,
  directParents: Map<NodeId, NodeId[]>,
  freshOutputs: Map<NodeId, NodeOutput>,
  cachedOutputs: Record<NodeId, NodeOutput>,
): Record<NodeId, NodeOutput> {
  const parentOutputs: Record<NodeId, NodeOutput> = {};

  for (const parentId of directParents.get(nodeId) ?? []) {
    if (freshOutputs.has(parentId)) {
      // A fresh output produced earlier in this rerun always wins over any
      // stale cached value for the same node.
      parentOutputs[parentId] = freshOutputs.get(parentId) as NodeOutput;
    } else if (Object.prototype.hasOwnProperty.call(cachedOutputs, parentId)) {
      parentOutputs[parentId] = cachedOutputs[parentId];
    } else {
      // Already validated upfront by assertRequiredCacheIsAvailable; this
      // is a defensive invariant check, not an expected user-facing path.
      throw new Error(
        `Missing cached output for parent "${parentId}" required by rerun node "${nodeId}"`,
      );
    }
  }

  return parentOutputs;
}

/**
 * Re-executes a graph starting from `targetNodeId`: the target node and
 * every one of its descendants run again. Any other node the execution
 * set actually depends on is resolved from `cachedOutputs` instead of
 * re-running; nodes outside the execution set that the rerun never
 * touches (disconnected or otherwise unrelated) are neither executed nor
 * reported as part of the cached dependency context. Database-independent,
 * like executeGraph - `cachedOutputs` is a plain in-memory map the caller
 * (the runs service) builds from a persisted prior run; this module never
 * touches persistence itself.
 *
 * Cache lookups use `Object.prototype.hasOwnProperty` rather than truthy
 * checks throughout, because a legitimate cached NodeOutput can be JSON
 * `null`, `false`, `0`, or `""` - all of which must be honored as present.
 */
export async function executeGraphFromNode(
  graph: Graph,
  targetNodeId: NodeId,
  registry: NodeRunnerRegistry,
  cachedOutputs: Record<NodeId, NodeOutput>,
): Promise<PartialExecutionResult> {
  validateGraph(graph);

  const descendants = getDescendants(graph, targetNodeId);
  const executionSet = new Set<NodeId>([targetNodeId, ...descendants]);

  const fullOrder = topologicalSort(graph);
  const executionOrder = fullOrder.filter((nodeId) => executionSet.has(nodeId));
  const cachedNodeIds = computeCachedDependencyNodeIds(graph, executionSet, fullOrder);

  const directParents = buildDirectParents(graph);

  // Fail fast, before running anything: if a node in the execution set
  // needs a non-executed parent with no cached output, executing part of
  // the rerun first would waste work (and any real side effects) on a
  // rerun that can never complete.
  assertRequiredCacheIsAvailable(executionSet, directParents, cachedOutputs);

  const freshOutputs = new Map<NodeId, NodeOutput>();
  const nodeResults: NodeExecutionResult[] = [];
  let status: NodeExecutionStatus = "success";

  for (const nodeId of executionOrder) {
    const parentOutputs = resolveParentOutputs(
      nodeId,
      directParents,
      freshOutputs,
      cachedOutputs,
    );

    const input: NodeExecutionInput = { nodeId, parentOutputs };
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();

    try {
      const runner = registry.getNodeRunner(nodeId);
      const output = await runner(input);
      const completedAtMs = Date.now();
      const completedAt = new Date(completedAtMs).toISOString();

      freshOutputs.set(nodeId, output);
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

  return { executionOrder, cachedNodeIds, nodeResults, status };
}
