import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import { Client } from "pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "..", "migrations");

// Arbitrary but stable numeric key for a PostgreSQL session-level advisory
// lock (pg_advisory_lock / pg_advisory_unlock). It serializes AgentTrace's
// migration runner so two processes starting at once cannot both compute
// the same "pending migrations" set and apply them concurrently. The value
// has no special meaning beyond being unique to this runner within the
// target database - it must stay constant across releases so every runner
// agrees on the same key, and must not collide with any other advisory
// lock key this application takes out (currently none).
const MIGRATION_ADVISORY_LOCK_KEY = 7_241_984_001;

export interface MigrationFile {
  version: string;
  filePath: string;
}

export function selectMigrationFileNames(fileNames: string[]): string[] {
  return fileNames.filter((fileName) => fileName.endsWith(".sql")).sort();
}

export function getPendingMigrationVersions(
  allVersions: string[],
  appliedVersions: Set<string>,
): string[] {
  return allVersions.filter((version) => !appliedVersions.has(version));
}

function loadMigrationFiles(): MigrationFile[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }

  const fileNames = selectMigrationFileNames(fs.readdirSync(MIGRATIONS_DIR));

  return fileNames.map((fileName) => ({
    version: fileName,
    filePath: path.join(MIGRATIONS_DIR, fileName),
  }));
}

async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedVersions(client: Client): Promise<Set<string>> {
  const result = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations",
  );

  return new Set(result.rows.map((row) => row.version));
}

async function applyMigration(
  client: Client,
  migration: MigrationFile,
): Promise<void> {
  const sql = fs.readFileSync(migration.filePath, "utf8");

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
      migration.version,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function withMigrationLock<T>(
  client: Client,
  run: () => Promise<T>,
): Promise<T> {
  await client.query("SELECT pg_advisory_lock($1::bigint)", [
    MIGRATION_ADVISORY_LOCK_KEY,
  ]);

  try {
    return await run();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [
      MIGRATION_ADVISORY_LOCK_KEY,
    ]);
  }
}

export async function runMigrations(): Promise<string[]> {
  if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.trim() === "") {
    throw new Error("DATABASE_URL is not set. Cannot run migrations.");
  }

  // A dedicated Client (not the shared pool) is used because session-level
  // advisory locks belong to the connection/session that acquired them:
  // the lock, migration-state reads/writes, and the unlock must all run on
  // this same connection for the duration of the migration run.
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    return await withMigrationLock(client, async () => {
      await ensureMigrationsTable(client);

      const appliedVersions = await getAppliedVersions(client);
      const migrationFiles = loadMigrationFiles();
      const pendingVersions = new Set(
        getPendingMigrationVersions(
          migrationFiles.map((migration) => migration.version),
          appliedVersions,
        ),
      );

      const appliedThisRun: string[] = [];

      for (const migration of migrationFiles) {
        if (!pendingVersions.has(migration.version)) {
          continue;
        }

        await applyMigration(client, migration);
        appliedThisRun.push(migration.version);
      }

      return appliedThisRun;
    });
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  try {
    const appliedThisRun = await runMigrations();

    if (appliedThisRun.length === 0) {
      console.log("No pending migrations. Database is up to date.");
    } else {
      console.log(`Applied ${appliedThisRun.length} migration(s): ${appliedThisRun.join(", ")}`);
    }
  } catch (error) {
    console.error("Migration failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
