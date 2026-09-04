import { pool } from "../../config/db";
import type { Graph } from "../graph/types";
import type { NodeExecutionResult, NodeExecutionStatus } from "../execution/types";
import type {
  PersistedNodeResult,
  PersistedRun,
  PersistedRunDetail,
  RunId,
  RunStatus,
} from "./types";

export interface RunsRepository {
  createRun(graph: Graph): Promise<RunId>;
  markRunRunning(runId: RunId): Promise<void>;
  insertNodeResult(runId: RunId, result: NodeExecutionResult): Promise<void>;
  finalizeRun(runId: RunId, status: NodeExecutionStatus): Promise<void>;
  getRunById(runId: RunId): Promise<PersistedRunDetail | null>;
}

// Raw column shapes as returned by node-postgres. Kept private to this
// module - the rest of the app only ever sees the PersistedRun /
// PersistedNodeResult domain types below. JSONB columns arrive already
// parsed into JS values; TIMESTAMPTZ columns arrive as Date instances.
interface RunRow {
  id: string;
  status: RunStatus;
  graph: Graph;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface NodeResultRow {
  id: string;
  run_id: string;
  node_id: string;
  status: NodeExecutionStatus;
  input: PersistedNodeResult["input"];
  output: PersistedNodeResult["output"];
  error: PersistedNodeResult["error"];
  started_at: Date;
  completed_at: Date;
  duration_ms: number;
  created_at: Date;
}

function mapRunRow(row: RunRow): PersistedRun {
  return {
    id: row.id,
    status: row.status,
    graph: row.graph,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at === null ? null : row.started_at.toISOString(),
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
  };
}

function mapNodeResultRow(row: NodeResultRow): PersistedNodeResult {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    status: row.status,
    input: row.input,
    output: row.output,
    error: row.error,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at.toISOString(),
    durationMs: row.duration_ms,
    createdAt: row.created_at.toISOString(),
  };
}

export interface NodeResultInsertParams {
  runId: RunId;
  nodeId: string;
  status: NodeExecutionStatus;
  input: string;
  output: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

/**
 * Pure param builder, exported for unit testing without a database.
 *
 * `output`/`error` are only ever populated for the status they belong to
 * (matching the node_results_status_payload_chk constraint), and when a
 * value IS populated it is always run through JSON.stringify first - even
 * when that value is a legitimate JSON `null` (JSON.stringify(null) is the
 * text "null"). Passing that text through a `::jsonb` cast stores a real
 * JSONB null value. Passing a bare JS `null` as the query parameter itself
 * (the "not applicable for this status" case below) is what produces true
 * SQL NULL. Conflating these two would either reject legitimate null
 * outputs or make failed/succeeded rows indistinguishable from ones with a
 * genuine null payload.
 */
export function buildNodeResultInsertParams(
  runId: RunId,
  result: NodeExecutionResult,
): NodeResultInsertParams {
  return {
    runId,
    nodeId: result.nodeId,
    status: result.status,
    input: JSON.stringify(result.input),
    output: result.status === "success" ? JSON.stringify(result.output) : null,
    error: result.status === "failed" ? JSON.stringify(result.error) : null,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
  };
}

export async function createRun(graph: Graph): Promise<RunId> {
  const result = await pool.query<{ id: RunId }>(
    `INSERT INTO runs (status, graph) VALUES ('pending', $1::jsonb) RETURNING id`,
    [JSON.stringify(graph)],
  );

  return result.rows[0].id;
}

export async function markRunRunning(runId: RunId): Promise<void> {
  const result = await pool.query(
    `UPDATE runs SET status = 'running', started_at = now() WHERE id = $1`,
    [runId],
  );

  if (result.rowCount === 0) {
    throw new Error(`Cannot mark run as running: run not found: ${runId}`);
  }
}

export async function insertNodeResult(
  runId: RunId,
  result: NodeExecutionResult,
): Promise<void> {
  const params = buildNodeResultInsertParams(runId, result);

  await pool.query(
    `INSERT INTO node_results (
       run_id, node_id, status, input, output, error,
       started_at, completed_at, duration_ms
     ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)`,
    [
      params.runId,
      params.nodeId,
      params.status,
      params.input,
      params.output,
      params.error,
      params.startedAt,
      params.completedAt,
      params.durationMs,
    ],
  );
}

export async function finalizeRun(
  runId: RunId,
  status: NodeExecutionStatus,
): Promise<void> {
  const result = await pool.query(
    `UPDATE runs SET status = $2, completed_at = now() WHERE id = $1`,
    [runId, status],
  );

  if (result.rowCount === 0) {
    throw new Error(`Cannot finalize run: run not found: ${runId}`);
  }
}

export async function getRunById(runId: RunId): Promise<PersistedRunDetail | null> {
  const runResult = await pool.query<RunRow>(
    `SELECT id, status, graph, created_at, started_at, completed_at
     FROM runs
     WHERE id = $1`,
    [runId],
  );

  const runRow = runResult.rows[0];
  if (runRow === undefined) {
    return null;
  }

  const nodeResultsResult = await pool.query<NodeResultRow>(
    `SELECT id, run_id, node_id, status, input, output, error,
            started_at, completed_at, duration_ms, created_at
     FROM node_results
     WHERE run_id = $1
     ORDER BY created_at ASC, id ASC`,
    [runId],
  );

  return {
    run: mapRunRow(runRow),
    nodeResults: nodeResultsResult.rows.map(mapNodeResultRow),
  };
}

export const runsRepository: RunsRepository = {
  createRun,
  markRunRunning,
  insertNodeResult,
  finalizeRun,
  getRunById,
};
