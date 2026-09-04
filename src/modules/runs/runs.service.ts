import type { Graph } from "../graph/types";
import { executeGraph } from "../execution/executor";
import type { ExecutionResult } from "../execution/types";
import type { NodeRunnerRegistry } from "../nodes/registry";
import { runsRepository, type RunsRepository } from "./runs.repo";
import type { PersistedRunDetail, RunId } from "./types";

export interface RunsServiceDeps {
  executeGraph: (graph: Graph, registry: NodeRunnerRegistry) => Promise<ExecutionResult>;
  repository: RunsRepository;
}

const defaultDeps: RunsServiceDeps = {
  executeGraph,
  repository: runsRepository,
};

/**
 * Runs a graph to completion and persists the full lifecycle: a pending
 * run row is created, transitioned to running, executed in-memory via
 * executeGraph (which has no knowledge of PostgreSQL), and every node
 * result the executor actually produced is written before the run is
 * finalized as success or failed.
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
 * If anything after createRun throws unexpectedly (executeGraph itself,
 * an insertNodeResult call, or the normal finalizeRun call), a run id
 * already exists and would otherwise be stuck at "running" for the rest
 * of this process's lifetime. On that path we make one best-effort
 * attempt to finalize the run as "failed" before re-throwing the
 * original error untouched - a failure in that cleanup attempt is
 * logged but never replaces the original error, and we never retry or
 * loop. A real process crash can still leave a run stuck "running";
 * that crash-recovery problem is out of scope here. If the normal
 * finalizeRun call itself succeeds, this function returns before the
 * catch block runs, so a run is never finalized twice.
 */
export async function executeAndPersistRun(
  graph: Graph,
  registry: NodeRunnerRegistry,
  deps: RunsServiceDeps = defaultDeps,
): Promise<RunId> {
  const { executeGraph: runGraph, repository } = deps;

  const runId = await repository.createRun(graph);

  try {
    await repository.markRunRunning(runId);

    const executionResult = await runGraph(graph, registry);

    for (const nodeResult of executionResult.nodeResults) {
      await repository.insertNodeResult(runId, nodeResult);
    }

    await repository.finalizeRun(runId, executionResult.status);

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

export async function getRun(
  runId: RunId,
  deps: Pick<RunsServiceDeps, "repository"> = defaultDeps,
): Promise<PersistedRunDetail | null> {
  return deps.repository.getRunById(runId);
}
