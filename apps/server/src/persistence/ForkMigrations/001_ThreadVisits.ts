import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * When each thread was last viewed, kept on the server so every device agrees
 * on which finished threads are unread (the sidebar's Done badge).
 *
 * `visited_at` is the time the client recorded: a turn's completion time for an
 * ordinary visit, or just before it for "mark unread". `marked_unread` is 1
 * when the latest write was a mark-unread, so clients take it even though it
 * moves the time backwards. `updated_at` is when the row last changed.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_visits (
      thread_id TEXT PRIMARY KEY,
      visited_at TEXT NOT NULL,
      marked_unread INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `;
});
