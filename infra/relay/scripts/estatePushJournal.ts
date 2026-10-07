// @effect-diagnostics nodeBuiltinImport:off - SQLite is the durable adapter journal.
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { eventForState } from "./estatePushEvents.ts";

// This is only a T3 event source. Registration, endpoint delivery, retry and
// device dedupe belong to the estate service, not this adapter.
export class EventJournal {
  readonly db: NodeSqlite.DatabaseSync;
  readonly clock: () => number;
  constructor(path: string, clock: () => number = () => Effect.runSync(Clock.currentTimeMillis)) {
    this.clock = clock;
    this.db = new NodeSqlite.DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS baseline (thread TEXT PRIMARY KEY, phase TEXT);
      CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, payload TEXT, expires REAL);`);
  }
  observe(state: Parameters<typeof eventForState>[0] | null, threadId: string, snapshot: boolean) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT phase FROM baseline WHERE thread=?").get(threadId) as
        | { phase: Parameters<typeof eventForState>[0]["phase"] }
        | undefined;
      // A fresh baseline is silent. A persisted active baseline may catch up a
      // transition across a short outage, but old unseen terminal threads do not.
      const event = state && (!snapshot || prior) ? eventForState(state, prior ?? null) : null;
      if (
        event &&
        Number.isFinite(event.occurred_at) &&
        event.occurred_at >= this.clock() / 1000 - 600
      ) {
        this.db
          .prepare("INSERT OR IGNORE INTO pending VALUES (?,?,?)")
          .run(event.event_id, JSON.stringify(event), event.occurred_at + 600);
      }
      if (state)
        this.db.prepare("INSERT OR REPLACE INTO baseline VALUES (?,?)").run(threadId, state.phase);
      else this.db.prepare("DELETE FROM baseline WHERE thread=?").run(threadId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async flush(url: string, token: string) {
    this.db.prepare("DELETE FROM pending WHERE expires<=?").run(this.clock() / 1000);
    for (const row of this.db.prepare("SELECT * FROM pending LIMIT 32").all() as {
      id: string;
      payload: string;
    }[]) {
      await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client
            .execute(
              HttpClientRequest.post(url).pipe(
                HttpClientRequest.bearerToken(token),
                HttpClientRequest.bodyText(row.payload, "application/json"),
              ),
            )
            .pipe(Effect.timeout("5 seconds"));
          if (response.status < 200 || response.status >= 300)
            return yield* Effect.fail("Estate event ingestion unavailable");
          const result = yield* response.json.pipe(Effect.timeout("5 seconds"));
          if (
            !result ||
            typeof result !== "object" ||
            !("queued" in result) ||
            typeof result.queued !== "number"
          ) {
            return yield* Effect.fail("Invalid ingestion response");
          }
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        ),
      );
      this.db.prepare("DELETE FROM pending WHERE id=?").run(row.id);
    }
  }
}
