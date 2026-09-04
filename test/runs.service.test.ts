import assert from "node:assert/strict";
import test from "node:test";

import { executeGraph } from "../src/modules/execution/executor";
import { executeGraphFromNode } from "../src/modules/execution/partial-executor";
import type {
  NodeExecutionInput,
  NodeExecutionResult,
} from "../src/modules/execution/types";
import type { Graph } from "../src/modules/graph/types";
import { createNodeRunnerRegistry } from "../src/modules/nodes/registry";
import type { RunsRepository } from "../src/modules/runs/runs.repo";
import {
  executeAndPersistRun,
  getRun,
  rerunFromNode,
} from "../src/modules/runs/runs.service";
import {
  RunNotFoundError,
  type PersistedNodeResult,
  type PersistedRun,
  type RunId,
} from "../src/modules/runs/types";

function createFakeRepository(): RunsRepository {
  const runs = new Map<RunId, PersistedRun>();
  const nodeResultsByRun = new Map<RunId, PersistedNodeResult[]>();
  let nextRunId = 1;
  let nextNodeResultId = 1;

  // JSON round-tripping simulates the JSONB storage boundary: it forces
  // every value through the same JSON-safe representation a real column
  // would produce, so a stored `null` reads back as `null`, not `undefined`.
  function roundTrip<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  return {
    async createRun(graph) {
      const id = `run-${nextRunId++}`;
      runs.set(id, {
        id,
        status: "pending",
        graph: roundTrip(graph),
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
      });
      nodeResultsByRun.set(id, []);
      return id;
    },

    async markRunRunning(runId) {
      const run = runs.get(runId);
      if (run === undefined) {
        throw new Error(`Cannot mark run as running: run not found: ${runId}`);
      }
      run.status = "running";
      run.startedAt = new Date().toISOString();
    },

    async insertNodeResult(runId, result: NodeExecutionResult) {
      const list = nodeResultsByRun.get(runId);
      if (list === undefined) {
        throw new Error(`Cannot insert node result: run not found: ${runId}`);
      }

      list.push({
        id: `node-result-${nextNodeResultId++}`,
        runId,
        nodeId: result.nodeId,
        status: result.status,
        input: roundTrip(result.input),
        output: result.status === "success" ? roundTrip(result.output) : null,
        error: result.status === "failed" ? roundTrip(result.error) : null,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        durationMs: result.durationMs,
        createdAt: new Date().toISOString(),
      });
    },

    async finalizeRun(runId, status) {
      const run = runs.get(runId);
      if (run === undefined) {
        throw new Error(`Cannot finalize run: run not found: ${runId}`);
      }
      run.status = status;
      run.completedAt = new Date().toISOString();
    },

    async getRunById(runId) {
      const run = runs.get(runId);
      if (run === undefined) {
        return null;
      }
      return {
        run: { ...run },
        nodeResults: [...(nodeResultsByRun.get(runId) ?? [])],
      };
    },
  };
}

const branchingGraph: Graph = {
  nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
  edges: [
    { from: "A", to: "B" },
    { from: "A", to: "C" },
    { from: "B", to: "D" },
    { from: "C", to: "D" },
  ],
};

function registerEchoRunners(
  registry: ReturnType<typeof createNodeRunnerRegistry>,
  graph: Graph,
  calls: NodeExecutionInput[] = [],
): void {
  for (const node of graph.nodes) {
    registry.registerNodeRunner(node.id, async (input) => {
      calls.push(input);
      return `${node.id}-output`;
    });
  }
}

test("a successful execution creates and finalizes the run as success", async () => {
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, branchingGraph);
  const repository = createFakeRepository();

  const runId = await executeAndPersistRun(branchingGraph, registry, {
    executeGraph,
    repository,
  });

  const detail = await getRun(runId, { repository });
  assert.ok(detail);
  assert.equal(detail.run.status, "success");
  assert.ok(detail.run.startedAt);
  assert.ok(detail.run.completedAt);
});

test("a failed execution finalizes the run as failed", async () => {
  const registry = createNodeRunnerRegistry();
  registry.registerNodeRunner("A", async () => "A-output");
  registry.registerNodeRunner("B", async () => {
    throw new Error("B blew up");
  });
  registry.registerNodeRunner("C", async () => "C-output");
  registry.registerNodeRunner("D", async () => "D-output");
  const repository = createFakeRepository();

  const runId = await executeAndPersistRun(branchingGraph, registry, {
    executeGraph,
    repository,
  });

  const detail = await getRun(runId, { repository });
  assert.ok(detail);
  assert.equal(detail.run.status, "failed");
  assert.ok(detail.run.completedAt);
});

test("a successful node result persists its output", async () => {
  const registry = createNodeRunnerRegistry();
  const graph: Graph = { nodes: [{ id: "A" }], edges: [] };
  registry.registerNodeRunner("A", async () => "A-output");
  const repository = createFakeRepository();

  const runId = await executeAndPersistRun(graph, registry, { executeGraph, repository });
  const detail = await getRun(runId, { repository });

  assert.ok(detail);
  assert.equal(detail.nodeResults.length, 1);
  assert.equal(detail.nodeResults[0].status, "success");
  assert.equal(detail.nodeResults[0].output, "A-output");
});

test("a successful JSON null output is persisted as null, not omitted", async () => {
  const registry = createNodeRunnerRegistry();
  const graph: Graph = { nodes: [{ id: "A" }], edges: [] };
  registry.registerNodeRunner("A", async () => null);
  const repository = createFakeRepository();

  const runId = await executeAndPersistRun(graph, registry, { executeGraph, repository });
  const detail = await getRun(runId, { repository });

  assert.ok(detail);
  const [nodeResult] = detail.nodeResults;
  assert.equal(nodeResult.status, "success");
  assert.equal(nodeResult.output, null);
  assert.ok(Object.prototype.hasOwnProperty.call(nodeResult, "output"));
});

test("a failed node persists its serialized error and no output", async () => {
  const registry = createNodeRunnerRegistry();
  const graph: Graph = { nodes: [{ id: "A" }], edges: [] };
  registry.registerNodeRunner("A", async () => {
    throw new TypeError("boom");
  });
  const repository = createFakeRepository();

  const runId = await executeAndPersistRun(graph, registry, { executeGraph, repository });
  const detail = await getRun(runId, { repository });

  assert.ok(detail);
  const [nodeResult] = detail.nodeResults;
  assert.equal(nodeResult.status, "failed");
  assert.equal(nodeResult.output, null);
  assert.deepEqual(nodeResult.error, { name: "TypeError", message: "boom" });
});

test("a root node's persisted input has empty parentOutputs", async () => {
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, branchingGraph);
  const repository = createFakeRepository();

  const runId = await executeAndPersistRun(branchingGraph, registry, {
    executeGraph,
    repository,
  });
  const detail = await getRun(runId, { repository });

  assert.ok(detail);
  const rootResult = detail.nodeResults.find((result) => result.nodeId === "A");
  assert.ok(rootResult);
  assert.deepEqual(rootResult.input.parentOutputs, {});
});

test("a child node's persisted input contains only its direct parent outputs", async () => {
  const registry = createNodeRunnerRegistry();
  registerEchoRunners(registry, branchingGraph);
  const repository = createFakeRepository();

  const runId = await executeAndPersistRun(branchingGraph, registry, {
    executeGraph,
    repository,
  });
  const detail = await getRun(runId, { repository });

  assert.ok(detail);
  const dResult = detail.nodeResults.find((result) => result.nodeId === "D");
  assert.ok(dResult);
  assert.deepEqual(dResult.input.parentOutputs, { B: "B-output", C: "C-output" });
  assert.equal(
    Object.prototype.hasOwnProperty.call(dResult.input.parentOutputs, "A"),
    false,
  );
});

test("downstream nodes that never ran after a failure are not persisted", async () => {
  const registry = createNodeRunnerRegistry();
  registry.registerNodeRunner("A", async () => "A-output");
  registry.registerNodeRunner("B", async () => {
    throw new Error("B blew up");
  });
  registry.registerNodeRunner("C", async () => "C-output");
  registry.registerNodeRunner("D", async () => "D-output");
  const repository = createFakeRepository();

  const runId = await executeAndPersistRun(branchingGraph, registry, {
    executeGraph,
    repository,
  });
  const detail = await getRun(runId, { repository });

  assert.ok(detail);
  assert.deepEqual(
    detail.nodeResults.map((result) => result.nodeId),
    ["A", "B"],
  );
});

test("persisted node timing comes directly from the executor result", async () => {
  const registry = createNodeRunnerRegistry();
  const graph: Graph = { nodes: [{ id: "A" }], edges: [] };
  registry.registerNodeRunner("A", async () => "A-output");

  let capturedResult: NodeExecutionResult | undefined;
  const baseRepository = createFakeRepository();
  const spyRepository: RunsRepository = {
    ...baseRepository,
    async insertNodeResult(runId, result) {
      capturedResult = result;
      await baseRepository.insertNodeResult(runId, result);
    },
  };

  const runId = await executeAndPersistRun(graph, registry, {
    executeGraph,
    repository: spyRepository,
  });
  const detail = await getRun(runId, { repository: spyRepository });

  assert.ok(detail);
  assert.ok(capturedResult);
  const [nodeResult] = detail.nodeResults;
  assert.equal(nodeResult.startedAt, capturedResult.startedAt);
  assert.equal(nodeResult.completedAt, capturedResult.completedAt);
  assert.equal(nodeResult.durationMs, capturedResult.durationMs);
});

test("getRun returns null for an unknown run id", async () => {
  const repository = createFakeRepository();

  const detail = await getRun("does-not-exist", { repository });

  assert.equal(detail, null);
});

test("an unexpected executeGraph error is best-effort finalized as failed and re-thrown", async () => {
  const registry = createNodeRunnerRegistry();
  const graph: Graph = { nodes: [{ id: "A" }], edges: [] };
  const repository = createFakeRepository();
  const explosion = new Error("executor exploded unexpectedly");

  const finalizeCalls: Array<{ runId: RunId; status: string }> = [];
  const spyRepository: RunsRepository = {
    ...repository,
    async finalizeRun(runId, status) {
      finalizeCalls.push({ runId, status });
      await repository.finalizeRun(runId, status);
    },
  };

  await assert.rejects(
    () =>
      executeAndPersistRun(graph, registry, {
        executeGraph: async () => {
          throw explosion;
        },
        repository: spyRepository,
      }),
    (error: unknown) => error === explosion,
  );

  assert.equal(finalizeCalls.length, 1);
  assert.equal(finalizeCalls[0].status, "failed");

  const runId = finalizeCalls[0].runId;
  const detail = await getRun(runId, { repository: spyRepository });
  assert.ok(detail);
  assert.equal(detail.run.status, "failed");
});

test("an insertNodeResult error is best-effort finalized as failed and re-thrown", async () => {
  const registry = createNodeRunnerRegistry();
  const graph: Graph = { nodes: [{ id: "A" }], edges: [] };
  registry.registerNodeRunner("A", async () => "A-output");
  const repository = createFakeRepository();
  const insertFailure = new Error("insertNodeResult exploded");

  let finalizeCallCount = 0;
  const spyRepository: RunsRepository = {
    ...repository,
    async insertNodeResult() {
      throw insertFailure;
    },
    async finalizeRun(runId, status) {
      finalizeCallCount += 1;
      await repository.finalizeRun(runId, status);
    },
  };

  await assert.rejects(
    () => executeAndPersistRun(graph, registry, { executeGraph, repository: spyRepository }),
    (error: unknown) => error === insertFailure,
  );

  assert.equal(finalizeCallCount, 1);
});

test("a cleanup finalizeRun failure does not mask the original orchestration error", async () => {
  const registry = createNodeRunnerRegistry();
  const graph: Graph = { nodes: [{ id: "A" }], edges: [] };
  const repository = createFakeRepository();
  const originalError = new Error("original orchestration failure");
  const cleanupError = new Error("cleanup finalizeRun also failed");

  const spyRepository: RunsRepository = {
    ...repository,
    async finalizeRun() {
      throw cleanupError;
    },
  };

  await assert.rejects(
    () =>
      executeAndPersistRun(graph, registry, {
        executeGraph: async () => {
          throw originalError;
        },
        repository: spyRepository,
      }),
    (error: unknown) => error === originalError,
  );
});

test("a createRun failure is re-thrown with no finalization attempt", async () => {
  const registry = createNodeRunnerRegistry();
  const graph: Graph = { nodes: [{ id: "A" }], edges: [] };
  const repository = createFakeRepository();
  const createFailure = new Error("createRun exploded");

  let finalizeCallCount = 0;
  const spyRepository: RunsRepository = {
    ...repository,
    async createRun() {
      throw createFailure;
    },
    async finalizeRun(runId, status) {
      finalizeCallCount += 1;
      await repository.finalizeRun(runId, status);
    },
  };

  await assert.rejects(
    () => executeAndPersistRun(graph, registry, { executeGraph, repository: spyRepository }),
    (error: unknown) => error === createFailure,
  );

  assert.equal(finalizeCallCount, 0);
});

test("a normal successful execution finalizes exactly once, as success", async () => {
  const registry = createNodeRunnerRegistry();
  const graph: Graph = { nodes: [{ id: "A" }], edges: [] };
  registry.registerNodeRunner("A", async () => "A-output");
  const repository = createFakeRepository();

  let finalizeCallCount = 0;
  const spyRepository: RunsRepository = {
    ...repository,
    async finalizeRun(runId, status) {
      finalizeCallCount += 1;
      await repository.finalizeRun(runId, status);
    },
  };

  const runId = await executeAndPersistRun(graph, registry, {
    executeGraph,
    repository: spyRepository,
  });
  const detail = await getRun(runId, { repository: spyRepository });

  assert.equal(finalizeCallCount, 1);
  assert.ok(detail);
  assert.equal(detail.run.status, "success");
});

test("a normal executor-reported failure finalizes exactly once, as failed", async () => {
  const registry = createNodeRunnerRegistry();
  const graph: Graph = { nodes: [{ id: "A" }], edges: [] };
  registry.registerNodeRunner("A", async () => {
    throw new Error("node A failed");
  });
  const repository = createFakeRepository();

  let finalizeCallCount = 0;
  const spyRepository: RunsRepository = {
    ...repository,
    async finalizeRun(runId, status) {
      finalizeCallCount += 1;
      await repository.finalizeRun(runId, status);
    },
  };

  const runId = await executeAndPersistRun(graph, registry, {
    executeGraph,
    repository: spyRepository,
  });
  const detail = await getRun(runId, { repository: spyRepository });

  assert.equal(finalizeCallCount, 1);
  assert.ok(detail);
  assert.equal(detail.run.status, "failed");
});

// ---------------------------------------------------------------------
// rerunFromNode: service/persistence orchestration for partial reruns
// ---------------------------------------------------------------------

const rerunLinearGraph: Graph = {
  nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
  edges: [
    { from: "A", to: "B" },
    { from: "B", to: "C" },
  ],
};

const rerunBranchingGraph: Graph = {
  nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
  edges: [
    { from: "A", to: "B" },
    { from: "A", to: "C" },
    { from: "B", to: "D" },
    { from: "C", to: "D" },
  ],
};

test("rerun: rerunFromNode loads the source run via getRunById", async () => {
  const repository = createFakeRepository();
  const sourceRegistry = createNodeRunnerRegistry();
  registerEchoRunners(sourceRegistry, rerunLinearGraph);
  const sourceRunId = await executeAndPersistRun(rerunLinearGraph, sourceRegistry, {
    executeGraph,
    repository,
  });

  const getRunByIdCalls: RunId[] = [];
  const spyRepository: RunsRepository = {
    ...repository,
    async getRunById(runId) {
      getRunByIdCalls.push(runId);
      return repository.getRunById(runId);
    },
  };

  const rerunRegistry = createNodeRunnerRegistry();
  registerEchoRunners(rerunRegistry, rerunLinearGraph);

  await rerunFromNode(sourceRunId, "B", rerunRegistry, {
    executeGraphFromNode,
    repository: spyRepository,
  });

  assert.deepEqual(getRunByIdCalls, [sourceRunId]);
});

test("rerun: creates a new run id, distinct from the source run", async () => {
  const repository = createFakeRepository();
  const sourceRegistry = createNodeRunnerRegistry();
  registerEchoRunners(sourceRegistry, rerunLinearGraph);
  const sourceRunId = await executeAndPersistRun(rerunLinearGraph, sourceRegistry, {
    executeGraph,
    repository,
  });

  const rerunRegistry = createNodeRunnerRegistry();
  registerEchoRunners(rerunRegistry, rerunLinearGraph);

  const newRunId = await rerunFromNode(sourceRunId, "B", rerunRegistry, {
    executeGraphFromNode,
    repository,
  });

  assert.notEqual(newRunId, sourceRunId);
});

test("rerun: the source run is left unchanged", async () => {
  const repository = createFakeRepository();
  const sourceRegistry = createNodeRunnerRegistry();
  registerEchoRunners(sourceRegistry, rerunLinearGraph);
  const sourceRunId = await executeAndPersistRun(rerunLinearGraph, sourceRegistry, {
    executeGraph,
    repository,
  });

  const beforeDetail = await getRun(sourceRunId, { repository });
  assert.ok(beforeDetail);

  const rerunRegistry = createNodeRunnerRegistry();
  registerEchoRunners(rerunRegistry, rerunLinearGraph);
  await rerunFromNode(sourceRunId, "B", rerunRegistry, {
    executeGraphFromNode,
    repository,
  });

  const afterDetail = await getRun(sourceRunId, { repository });
  assert.deepEqual(afterDetail, beforeDetail);
});

test("rerun: the new run stores the same graph as the source run", async () => {
  const repository = createFakeRepository();
  const sourceRegistry = createNodeRunnerRegistry();
  registerEchoRunners(sourceRegistry, rerunLinearGraph);
  const sourceRunId = await executeAndPersistRun(rerunLinearGraph, sourceRegistry, {
    executeGraph,
    repository,
  });

  const rerunRegistry = createNodeRunnerRegistry();
  registerEchoRunners(rerunRegistry, rerunLinearGraph);
  const newRunId = await rerunFromNode(sourceRunId, "B", rerunRegistry, {
    executeGraphFromNode,
    repository,
  });

  const newDetail = await getRun(newRunId, { repository });
  assert.ok(newDetail);
  assert.deepEqual(newDetail.run.graph, rerunLinearGraph);
});

test("rerun: only newly executed nodes are persisted, cached ancestors are not duplicated", async () => {
  const repository = createFakeRepository();
  const sourceRegistry = createNodeRunnerRegistry();
  registerEchoRunners(sourceRegistry, rerunLinearGraph);
  const sourceRunId = await executeAndPersistRun(rerunLinearGraph, sourceRegistry, {
    executeGraph,
    repository,
  });

  const rerunRegistry = createNodeRunnerRegistry();
  registerEchoRunners(rerunRegistry, rerunLinearGraph);
  const newRunId = await rerunFromNode(sourceRunId, "B", rerunRegistry, {
    executeGraphFromNode,
    repository,
  });

  const newDetail = await getRun(newRunId, { repository });
  assert.ok(newDetail);
  assert.deepEqual(
    newDetail.nodeResults.map((result) => result.nodeId).sort(),
    ["B", "C"],
  );
});

test("rerun: a successful source node output becomes the cache input", async () => {
  const repository = createFakeRepository();
  const sourceRegistry = createNodeRunnerRegistry();
  sourceRegistry.registerNodeRunner("A", async () => "source-A-output");
  sourceRegistry.registerNodeRunner("B", async () => "source-B-output");
  sourceRegistry.registerNodeRunner("C", async () => "source-C-output");
  const sourceRunId = await executeAndPersistRun(rerunLinearGraph, sourceRegistry, {
    executeGraph,
    repository,
  });

  let capturedInput: NodeExecutionInput | undefined;
  const rerunRegistry = createNodeRunnerRegistry();
  rerunRegistry.registerNodeRunner("B", async (input) => {
    capturedInput = input;
    return "rerun-B-output";
  });
  rerunRegistry.registerNodeRunner("C", async () => "rerun-C-output");

  await rerunFromNode(sourceRunId, "B", rerunRegistry, {
    executeGraphFromNode,
    repository,
  });

  assert.deepEqual(capturedInput?.parentOutputs, { A: "source-A-output" });
});

test("rerun: a failed source node's output is not eligible as a cached dependency", async () => {
  const repository = createFakeRepository();
  const sourceRegistry = createNodeRunnerRegistry();
  sourceRegistry.registerNodeRunner("A", async () => "source-A-output");
  sourceRegistry.registerNodeRunner("B", async () => {
    throw new Error("B failed in the source run");
  });
  // C never ran in the source run because B failed first.
  const sourceRunId = await executeAndPersistRun(rerunLinearGraph, sourceRegistry, {
    executeGraph,
    repository,
  });

  const rerunRegistry = createNodeRunnerRegistry();
  rerunRegistry.registerNodeRunner("C", async () => "rerun-C-output");

  await assert.rejects(
    () =>
      rerunFromNode(sourceRunId, "C", rerunRegistry, {
        executeGraphFromNode,
        repository,
      }),
    /Missing cached output for parent "B" required by rerun node "C"/,
  );
});

test("rerun: an unknown source run id throws RunNotFoundError", async () => {
  const repository = createFakeRepository();
  const registry = createNodeRunnerRegistry();

  await assert.rejects(
    () =>
      rerunFromNode("does-not-exist", "B", registry, {
        executeGraphFromNode,
        repository,
      }),
    (error: unknown) => error instanceof RunNotFoundError,
  );
});

test("rerun: recovery from a failed node executes it and downstream, with the earlier success cached", async () => {
  const repository = createFakeRepository();
  const sourceRegistry = createNodeRunnerRegistry();
  sourceRegistry.registerNodeRunner("A", async () => "source-A-output");
  sourceRegistry.registerNodeRunner("B", async () => {
    throw new Error("B failed in the source run");
  });
  const sourceRunId = await executeAndPersistRun(rerunLinearGraph, sourceRegistry, {
    executeGraph,
    repository,
  });
  const sourceDetail = await getRun(sourceRunId, { repository });
  assert.ok(sourceDetail);
  assert.equal(sourceDetail.run.status, "failed");

  const calls: NodeExecutionInput[] = [];
  const rerunRegistry = createNodeRunnerRegistry();
  registerEchoRunners(rerunRegistry, rerunLinearGraph, calls);

  const newRunId = await rerunFromNode(sourceRunId, "B", rerunRegistry, {
    executeGraphFromNode,
    repository,
  });

  const newDetail = await getRun(newRunId, { repository });
  assert.ok(newDetail);
  assert.equal(newDetail.run.status, "success");
  assert.deepEqual(
    calls.map((call) => call.nodeId),
    ["B", "C"],
  );
  const bCall = calls.find((call) => call.nodeId === "B");
  assert.deepEqual(bCall?.parentOutputs, { A: "source-A-output" });
});

test("rerun: missing required cache from a branch that never executed in the source run fails clearly", async () => {
  const repository = createFakeRepository();
  const sourceRegistry = createNodeRunnerRegistry();
  sourceRegistry.registerNodeRunner("A", async () => "source-A-output");
  sourceRegistry.registerNodeRunner("B", async () => {
    throw new Error("B failed in the source run");
  });
  // C and D never ran in the source run because B failed first.
  const sourceRunId = await executeAndPersistRun(rerunBranchingGraph, sourceRegistry, {
    executeGraph,
    repository,
  });

  const rerunRegistry = createNodeRunnerRegistry();
  rerunRegistry.registerNodeRunner("B", async () => "rerun-B-output");
  rerunRegistry.registerNodeRunner("D", async () => "rerun-D-output");

  await assert.rejects(
    () =>
      rerunFromNode(sourceRunId, "B", rerunRegistry, {
        executeGraphFromNode,
        repository,
      }),
    /Missing cached output for parent "C" required by rerun node "D"/,
  );
});

test("rerun: a successful rerun finalizes the new run as success", async () => {
  const repository = createFakeRepository();
  const sourceRegistry = createNodeRunnerRegistry();
  registerEchoRunners(sourceRegistry, rerunLinearGraph);
  const sourceRunId = await executeAndPersistRun(rerunLinearGraph, sourceRegistry, {
    executeGraph,
    repository,
  });

  const rerunRegistry = createNodeRunnerRegistry();
  registerEchoRunners(rerunRegistry, rerunLinearGraph);
  const newRunId = await rerunFromNode(sourceRunId, "B", rerunRegistry, {
    executeGraphFromNode,
    repository,
  });

  const newDetail = await getRun(newRunId, { repository });
  assert.ok(newDetail);
  assert.equal(newDetail.run.status, "success");
});

test("rerun: an executor-reported rerun failure finalizes the new run as failed", async () => {
  const repository = createFakeRepository();
  const sourceRegistry = createNodeRunnerRegistry();
  registerEchoRunners(sourceRegistry, rerunLinearGraph);
  const sourceRunId = await executeAndPersistRun(rerunLinearGraph, sourceRegistry, {
    executeGraph,
    repository,
  });

  const rerunRegistry = createNodeRunnerRegistry();
  rerunRegistry.registerNodeRunner("B", async () => {
    throw new Error("B fails again on rerun");
  });
  rerunRegistry.registerNodeRunner("C", async () => "rerun-C-output");

  const newRunId = await rerunFromNode(sourceRunId, "B", rerunRegistry, {
    executeGraphFromNode,
    repository,
  });

  const newDetail = await getRun(newRunId, { repository });
  assert.ok(newDetail);
  assert.equal(newDetail.run.status, "failed");
});

test("rerun: an unexpected error triggers best-effort failed finalization and is re-thrown", async () => {
  const repository = createFakeRepository();
  const sourceRegistry = createNodeRunnerRegistry();
  registerEchoRunners(sourceRegistry, rerunLinearGraph);
  const sourceRunId = await executeAndPersistRun(rerunLinearGraph, sourceRegistry, {
    executeGraph,
    repository,
  });

  const explosion = new Error("rerun executor exploded unexpectedly");
  const finalizeCalls: Array<{ runId: RunId; status: string }> = [];
  const spyRepository: RunsRepository = {
    ...repository,
    async finalizeRun(runId, status) {
      finalizeCalls.push({ runId, status });
      await repository.finalizeRun(runId, status);
    },
  };

  const rerunRegistry = createNodeRunnerRegistry();

  await assert.rejects(
    () =>
      rerunFromNode(sourceRunId, "B", rerunRegistry, {
        executeGraphFromNode: async () => {
          throw explosion;
        },
        repository: spyRepository,
      }),
    (error: unknown) => error === explosion,
  );

  assert.equal(finalizeCalls.length, 1);
  assert.equal(finalizeCalls[0].status, "failed");
  assert.notEqual(finalizeCalls[0].runId, sourceRunId);
});

test("rerun: a cleanup finalizeRun failure does not mask the original error", async () => {
  const repository = createFakeRepository();
  const sourceRegistry = createNodeRunnerRegistry();
  registerEchoRunners(sourceRegistry, rerunLinearGraph);
  const sourceRunId = await executeAndPersistRun(rerunLinearGraph, sourceRegistry, {
    executeGraph,
    repository,
  });

  const originalError = new Error("original rerun orchestration failure");
  const cleanupError = new Error("cleanup finalizeRun also failed");
  const spyRepository: RunsRepository = {
    ...repository,
    async finalizeRun() {
      throw cleanupError;
    },
  };

  const rerunRegistry = createNodeRunnerRegistry();

  await assert.rejects(
    () =>
      rerunFromNode(sourceRunId, "B", rerunRegistry, {
        executeGraphFromNode: async () => {
          throw originalError;
        },
        repository: spyRepository,
      }),
    (error: unknown) => error === originalError,
  );
});
