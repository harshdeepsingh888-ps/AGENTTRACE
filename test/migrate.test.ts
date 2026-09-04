import assert from "node:assert/strict";
import test from "node:test";

import {
  getPendingMigrationVersions,
  selectMigrationFileNames,
} from "../src/config/migrate";

test("selectMigrationFileNames keeps only .sql files, sorted", () => {
  const fileNames = [
    "002_add_something.sql",
    "readme.md",
    "001_create_execution_tables.sql",
    ".gitkeep",
  ];

  assert.deepEqual(selectMigrationFileNames(fileNames), [
    "001_create_execution_tables.sql",
    "002_add_something.sql",
  ]);
});

test("getPendingMigrationVersions excludes already-applied versions", () => {
  const all = ["001_create_execution_tables.sql", "002_add_something.sql"];
  const applied = new Set(["001_create_execution_tables.sql"]);

  assert.deepEqual(getPendingMigrationVersions(all, applied), [
    "002_add_something.sql",
  ]);
});

test("getPendingMigrationVersions returns everything when nothing is applied", () => {
  const all = ["001_create_execution_tables.sql"];

  assert.deepEqual(getPendingMigrationVersions(all, new Set()), all);
});

test("getPendingMigrationVersions returns nothing when everything is applied", () => {
  const all = ["001_create_execution_tables.sql"];

  assert.deepEqual(
    getPendingMigrationVersions(all, new Set(all)),
    [],
  );
});
