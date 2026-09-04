import type { Graph, NodeId } from "../graph/types";
import { executeGraph } from "../execution/executor";
import { executeGraphFromNode } from "../execution/partial-executor";
import type {
  ExecutionResult,
  NodeExecutionResult,
  NodeExecutionStatus,
  NodeOutput,
  PartialExecutionResult,
} from "../execution/types";
import type { NodeRunnerRegistry } from "../nodes/registry";
import { runsRepository, type RunsRepository } from "./runs.repo";
import { RunNotFoundError, type PersistedNodeResult, type PersistedRunDetail, type RunId } from "./types";

export interface RunsServiceDeps {
  executeGraph: (graph: Graph, registry: NodeRunnerRegistry) => Promise<ExecutionResult>;
  repository: RunsRepository;
}

const defaultDeps: RunsServiceDeps = {
  executeGraph,
  repository: runsRepository,
};

export interface RerunServiceDeps {
  executeGraphFromNode: (
    graph: Graph,
    targetNodeId: NodeId,
    registry: NodeRunnerRegistry,
    cachedOutputs: Record<NodeId, NodeOutput>,
  ) => Promise<PartialExecutionResult>;
  repository: RunsRepository;
}

const defaultRerunDeps: RerunServiceDeps = {
  executeGraphFromNode,
  repository: runsRepository,
};

// The common shape executeGraph's ExecutionResult and the partial
// executor's PartialExecutionResult both satisfy - all persistRunExecution
// needs in order to write node results and finalize the run.
interface RunExecutionOutcome {
  nodeResults: NodeExecutionResult[];
  status: NodeExecutionStatus;
}

/**
 * Shared lifecycle for a run row that already exists (`runId`): marks it
 * running, runs the supplied execution function, persists every node
 * result it actually produced, then finalizes success/failed.
 *
 * Node results are written with individual statements after execution
 * finishes rather than inside one transaction spanning the whole run.
 * This is deliberate, not just simple: holding a single DB transaction
 * open for the full duration of graph execution would tie up a pooled
 * connection for as long as the slowest node runner takes (potentially
 * arbitrary external calls), risking pool exhaustion. The tradeoff is
 * that if the process crashes after some insertNodeResult calls but
 * before finalizeRun, a run can be observed "running" with only a
 * partial set of node results - a recoverable, inspectable state, not a
 * corrupted one, and reconciling it is left to future rerun/lineage work.
 *
 * If anything after this point throws unexpectedly (the execution
 * function itself, an insertNodeResult call, or the normal finalizeRun
 * call), the run id already exists and would otherwise be stuck at
 * "running" for the rest of this process's lifetime. On that path we make
 * one best-effort attempt to finalize the run as "failed" before
 * re-throwing the original error untouched - a failure in that cleanup
 * attempt is logged but never replaces the original error, and we never
 * retry or loop. A real process crash can still leave a run stuck
 * "running"; that crash-recovery problem is out of scope here. If the
 * normal finalizeRun call itself succeeds, this function returns before
 * the catch block runs, so a run is never finalized twice.
 */
async function persistRunExecution(
  runId: RunId,
  repository: RunsRepository,
  run: () => Promise<RunExecutionOutcome>,
): Promise<RunId> {
  try {
    await repository.markRunRunning(runId);

    const outcome = await run();

    for (const nodeResult of outcome.nodeResults) {
      await repository.insertNodeResult(runId, nodeResult);
    }

    await repository.finalizeRun(runId, outcome.status);

    return runId;
  } catch (error) {
    try {
      await repository.finalizeRun(runId, "failed");
    } catch (cleanupError) {
      console.error(
        `Best-effort failure finalization also failed for run ${runId}:`,
        cleanupError,
      );
    }

    throw error;
  }
}

/**
 * Runs a graph to completion and persists the full lifecycle: a pending
 * run row is created, transitioned to running, executed in-memory via
 * executeGraph (which has no knowledge of PostgreSQL), and every node
 * result the executor actually produced is written before the run is
 * finalized as success or failed.
 */
export async function executeAndPersistRun(
  graph: Graph,
  registry: NodeRunnerRegistry,
  deps: RunsServiceDeps = defaultDeps,
): Promise<RunId> {
  const { executeGraph: runGraph, repository } = deps;

  const runId = await repository.createRun(graph);

  return persistRunExecution(runId, repository, () => runGraph(graph, registry));
}

/**
 * Builds the cached-output map a partial rerun needs from a previously
 * persisted run: only SUCCESSFUL node results are eligible as cache - a
 * failed node's prior result must never be treated as a usable cached
 * dependency, so it is simply omitted from the map (not stored as
 * `undefined` or `null`), letting the partial executor's own
 * hasOwnProperty-based "is this cached?" check correctly say no.
 */
function buildCachedOutputs(
  nodeResults: PersistedNodeResult[],
): Record<NodeId, NodeOutput> {
  const cachedOutputs: Record<NodeId, NodeOutput> = {};

  for (const nodeResult of nodeResults) {
    if (nodeResult.status === "success") {
      cachedOutputs[nodeResult.nodeId] = nodeResult.output as NodeOutput;
    }
  }

  return cachedOutputs;
}

/**
 * Re-runs a persisted source run starting from `targetNodeId`: loads the
 * source run (never mutating it), builds a cache of its successful node
 * outputs, and executes a brand-new run against the same graph via the
 * database-independent partial executor. Only nodes that actually
 * re-execute (the target and its descendants) get node_results rows in
 * the new run - cached ancestors are not duplicated into it.
 */
export async function rerunFromNode(
  sourceRunId: RunId,
  targetNodeId: NodeId,
  registry: NodeRunnerRegistry,
  deps: RerunServiceDeps = defaultRerunDeps,
): Promise<RunId> {
  const { executeGraphFromNode: runPartial, repository } = deps;

  const sourceRunDetail = await repository.getRunById(sourceRunId);
  if (sourceRunDetail === null) {
    throw new RunNotFoundError(sourceRunId);
  }

  const { graph } = sourceRunDetail.run;
  const cachedOutputs = buildCachedOutputs(sourceRunDetail.nodeResults);

  const runId = await repository.createRun(graph);

  return persistRunExecution(runId, repository, () =>
    runPartial(graph, targetNodeId, registry, cachedOutputs),
  );
}

export async function getRun(
  runId: RunId,
  deps: Pick<RunsServiceDeps, "repository"> = defaultDeps,
): Promise<PersistedRunDetail | null> {
  return deps.repository.getRunById(runId);
}
