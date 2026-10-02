import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import { FORK_MIGRATIONS_TABLE, runForkMigrations } from "./ForkMigrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("fork migration ledger", (it) => {
  it.effect("keeps fork ids out of upstream's ledger and runs each migration once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const first = yield* runForkMigrations();
      assert.deepEqual(
        first.map(([id, name]) => `${id}_${name}`),
        ["1_ThreadVisits"],
      );

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fork_thread_visits'
      `;
      assert.deepEqual(tables, [{ name: "fork_thread_visits" }]);

      // Upstream's ledger holds exactly upstream's ids; its next migration still runs.
      const upstreamIds = yield* sql<{ readonly id: number }>`
        SELECT migration_id AS "id" FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepEqual(
        upstreamIds.map((row) => row.id),
        migrationManifest.map(([id]) => id),
      );
      const forkIds = yield* sql<{ readonly id: number }>`
        SELECT migration_id AS "id" FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id
      `;
      assert.deepEqual(
        forkIds.map((row) => row.id),
        [1],
      );

      const second = yield* runForkMigrations();
      assert.deepEqual(second, []);
    }),
  );
});
