/**
 * ThreadVisitStore - when each thread was last viewed, on the server.
 *
 * Fork feature (namrop/t3code). Upstream keeps last-viewed times only in each
 * browser, so the sidebar's Done badge disagrees between devices and misses
 * threads that were never viewed after finishing in that browser. Keeping the
 * times here, with a change stream, lets every connected client agree live.
 *
 * Two writes, matching the client's two:
 * - `visit` only moves the stored time forward (the client's markThreadVisited
 *   never moves backwards either).
 * - `markUnread` sets the time exactly, even backwards, and flags the row so
 *   clients take it over a later local time.
 *
 * @module ThreadVisitStore
 */
import { type ThreadVisit, type ThreadVisitInput, ThreadVisitsError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface ThreadVisitStoreShape {
  readonly list: Effect.Effect<ReadonlyArray<ThreadVisit>, ThreadVisitsError>;
  readonly visit: (input: ThreadVisitInput) => Effect.Effect<ThreadVisit, ThreadVisitsError>;
  readonly markUnread: (input: ThreadVisitInput) => Effect.Effect<ThreadVisit, ThreadVisitsError>;
  /** Each row as it changes. Writes that change nothing publish nothing. */
  readonly streamChanges: Stream.Stream<ThreadVisit>;
}

export class ThreadVisitStore extends Context.Service<ThreadVisitStore, ThreadVisitStoreShape>()(
  "t3/threadVisits/ThreadVisitStore",
) {}

interface ThreadVisitRow {
  readonly threadId: string;
  readonly visitedAt: string;
  readonly markedUnread: number;
  readonly updatedAt: string;
}

const toThreadVisit = (row: ThreadVisitRow): ThreadVisit =>
  ({
    threadId: row.threadId,
    visitedAt: row.visitedAt,
    markedUnread: row.markedUnread === 1,
    updatedAt: row.updatedAt,
  }) as ThreadVisit;

const toThreadVisitsError =
  (operation: string) =>
  (cause: unknown): ThreadVisitsError =>
    new ThreadVisitsError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
    });

/** What a write should store, or null when the stored row already says it. */
type Decide = (
  current: ThreadVisitRow | undefined,
  visitedAt: string,
  visitedAtMs: number,
) => { readonly visitedAt: string; readonly markedUnread: boolean } | null;

const decideVisit: Decide = (current, visitedAt, visitedAtMs) => {
  if (current !== undefined) {
    const currentMs = Date.parse(current.visitedAt);
    if (Number.isFinite(currentMs) && currentMs >= visitedAtMs) return null;
  }
  return { visitedAt, markedUnread: false };
};

const decideMarkUnread: Decide = (current, visitedAt) => {
  if (current !== undefined && current.markedUnread === 1 && current.visitedAt === visitedAt) {
    return null;
  }
  return { visitedAt, markedUnread: true };
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<ThreadVisit>();

  const selectAll = sql<ThreadVisitRow>`
    SELECT
      thread_id AS "threadId",
      visited_at AS "visitedAt",
      marked_unread AS "markedUnread",
      updated_at AS "updatedAt"
    FROM fork_thread_visits
    ORDER BY thread_id
  `;

  const selectOne = (threadId: string) => sql<ThreadVisitRow>`
    SELECT
      thread_id AS "threadId",
      visited_at AS "visitedAt",
      marked_unread AS "markedUnread",
      updated_at AS "updatedAt"
    FROM fork_thread_visits
    WHERE thread_id = ${threadId}
  `;

  const write = (operation: string, input: ThreadVisitInput, decide: Decide) =>
    Effect.gen(function* () {
      const visitedAtMs = Date.parse(input.visitedAt);
      if (!Number.isFinite(visitedAtMs)) {
        return yield* new ThreadVisitsError({
          operation,
          message: `visitedAt is not a time: ${input.visitedAt}`,
        });
      }
      // One format on the server, so equal times compare equal as text.
      const visitedAt = new Date(visitedAtMs).toISOString();
      const outcome = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const [current] = yield* selectOne(input.threadId);
            const next = decide(current, visitedAt, visitedAtMs);
            if (next === null) {
              return { changed: false as const, row: toThreadVisit(current!) };
            }
            const updatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
            const markedUnread = next.markedUnread ? 1 : 0;
            yield* sql`
              INSERT INTO fork_thread_visits (thread_id, visited_at, marked_unread, updated_at)
              VALUES (${input.threadId}, ${next.visitedAt}, ${markedUnread}, ${updatedAt})
              ON CONFLICT (thread_id) DO UPDATE SET
                visited_at = excluded.visited_at,
                marked_unread = excluded.marked_unread,
                updated_at = excluded.updated_at
            `;
            return {
              changed: true as const,
              row: toThreadVisit({
                threadId: input.threadId,
                visitedAt: next.visitedAt,
                markedUnread,
                updatedAt,
              }),
            };
          }),
        )
        .pipe(Effect.mapError(toThreadVisitsError(operation)));
      if (outcome.changed) {
        yield* PubSub.publish(changes, outcome.row);
      }
      return outcome.row;
    });

  return {
    list: selectAll.pipe(
      Effect.map((rows) => rows.map(toThreadVisit)),
      Effect.mapError(toThreadVisitsError("ThreadVisitStore.list")),
    ),
    visit: (input) => write("ThreadVisitStore.visit", input, decideVisit),
    markUnread: (input) => write("ThreadVisitStore.markUnread", input, decideMarkUnread),
    get streamChanges() {
      return Stream.fromPubSub(changes);
    },
  } satisfies ThreadVisitStoreShape;
});

export const layer = Layer.effect(ThreadVisitStore, make);
