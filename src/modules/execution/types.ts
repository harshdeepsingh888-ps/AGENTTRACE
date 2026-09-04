import type { NodeId } from "../graph/types";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type NodeOutput = JsonValue;

export interface NodeExecutionInput {
  nodeId: NodeId;
  parentOutputs: Record<NodeId, NodeOutput>;
}

export type NodeRunner = (
  input: NodeExecutionInput,
) => Promise<NodeOutput>;

export type NodeExecutionStatus = "success" | "failed";

export interface SerializableError {
  name?: string;
  message: string;
}

interface NodeExecutionResultBase {
  nodeId: NodeId;
  input: NodeExecutionInput;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface NodeExecutionSuccessResult extends NodeExecutionResultBase {
  status: "success";
  output: NodeOutput;
}

export interface NodeExecutionFailureResult extends NodeExecutionResultBase {
  status: "failed";
  error: SerializableError;
}

export type NodeExecutionResult =
  | NodeExecutionSuccessResult
  | NodeExecutionFailureResult;

export interface ExecutionResult {
  executionOrder: NodeId[];
  nodeResults: NodeExecutionResult[];
  status: NodeExecutionStatus;
}
