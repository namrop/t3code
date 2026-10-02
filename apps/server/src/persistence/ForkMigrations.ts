/**
 * Migrations owned by this fork (namrop/t3code), kept in their own ledger.
 *
 * Upstream's migrator runs only migrations numbered above the highest one it
 * has recorded. A fork migration in upstream's numbering would either take a
 * number upstream later uses (upstream's then never runs) or, numbered high,
 * block every upstream migration after it. So fork tables are created by a
 * second migrator that records its ids in `fork_sql_migrations`, numbered from
 * 1, and runs after upstream's. Upstream's ledger never sees these ids.
 *
 * @module ForkMigrations
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import ForkMigration0001 from "./ForkMigrations/001_ThreadVisits.ts";

export const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

const forkMigrationEntries = [[1, "ThreadVisits", ForkMigration0001]] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const makeForkMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

export interface RunForkMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/** Run every fork migration not yet recorded in `fork_sql_migrations`. */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* ({
  toMigrationInclusive,
}: RunForkMigrationsOptions = {}) {
  const executedMigrations = yield* run({
    loader: makeForkMigrationLoader(toMigrationInclusive),
    table: FORK_MIGRATIONS_TABLE,
  });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Fork database schema is current")
    : Effect.log("Fork migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
