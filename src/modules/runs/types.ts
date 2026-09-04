import type { Graph, NodeId } from "../graph/types";
import type {
  NodeExecutionInput,
  NodeExecutionStatus,
  NodeOutput,
  SerializableError,
} from "../execution/types";

export type RunId = string;

export type RunStatus = "pending" | "running" | "success" | "failed";

export interface PersistedRun {
  id: RunId;
  status: RunStatus;
  graph: Graph;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PersistedNodeResult {
  id: string;
  runId: RunId;
  nodeId: NodeId;
  status: NodeExecutionStatus;
  input: NodeExecutionInput;
  output: NodeOutput | null;
  error: SerializableError | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  createdAt: string;
}

export interface PersistedRunDetail {
  run: PersistedRun;
  nodeResults: PersistedNodeResult[];
}
