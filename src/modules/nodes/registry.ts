import type { NodeId } from "../graph/types";
import type { NodeRunner } from "../execution/types";

export interface NodeRunnerRegistry {
  registerNodeRunner(nodeId: NodeId, runner: NodeRunner): void;
  getNodeRunner(nodeId: NodeId): NodeRunner;
}

export function createNodeRunnerRegistry(): NodeRunnerRegistry {
  const runners = new Map<NodeId, NodeRunner>();

  return {
    registerNodeRunner(nodeId: NodeId, runner: NodeRunner): void {
      if (runners.has(nodeId)) {
        throw new Error(`Node runner is already registered for node id: ${nodeId}`);
      }

      runners.set(nodeId, runner);
    },

    getNodeRunner(nodeId: NodeId): NodeRunner {
      const runner = runners.get(nodeId);
      if (runner === undefined) {
        throw new Error(`No node runner registered for node id: ${nodeId}`);
      }

      return runner;
    },
  };
}
