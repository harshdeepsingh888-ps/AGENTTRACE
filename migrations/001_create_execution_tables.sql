-- gen_random_uuid() is built into PostgreSQL core (13+); no extension needed.

CREATE TABLE runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed')),
  graph JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE node_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  input JSONB NOT NULL,
  output JSONB,
  error JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT node_results_run_id_node_id_key UNIQUE (run_id, node_id),
  -- A JSONB column holding the JSON value `null` is NOT the same as the
  -- column being SQL NULL, so this constraint requires that a value was
  -- actually recorded (output/error IS NOT NULL) without forbidding a
  -- legitimate JSON `null` output on success.
  CONSTRAINT node_results_status_payload_chk CHECK (
    (status = 'success' AND output IS NOT NULL AND error IS NULL)
    OR
    (status = 'failed' AND error IS NOT NULL AND output IS NULL)
  )
);

-- No separate index on node_results(run_id): the UNIQUE (run_id, node_id)
-- constraint above already creates a btree index with run_id as the
-- leading column, which serves lookups filtered by run_id alone.
