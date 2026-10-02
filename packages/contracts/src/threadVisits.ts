/**
 * Thread visits: when each thread was last viewed, kept on the server so every
 * device agrees on which finished threads are unread (the sidebar's Done badge).
 *
 * Fork feature (namrop/t3code). Upstream keeps these times only in each
 * browser's localStorage.
 *
 * @module threadVisits
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

export const ThreadVisit = Schema.Struct({
  threadId: ThreadId,
  /** The time the thread counts as viewed up to. */
  visitedAt: IsoDateTime,
  /** True when the latest write was "mark unread", which may move the time backwards. */
  markedUnread: Schema.Boolean,
  /** When the server last changed this row. */
  updatedAt: IsoDateTime,
});
export type ThreadVisit = typeof ThreadVisit.Type;

export const ThreadVisitInput = Schema.Struct({
  threadId: ThreadId,
  visitedAt: IsoDateTime,
});
export type ThreadVisitInput = typeof ThreadVisitInput.Type;

export const ThreadVisitsSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  visits: Schema.Array(ThreadVisit),
});

export const ThreadVisitsChangedEvent = Schema.Struct({
  type: Schema.Literal("changed"),
  visit: ThreadVisit,
});

/** The subscription sends one snapshot of every row, then each changed row. */
export const ThreadVisitsStreamEvent = Schema.Union([
  ThreadVisitsSnapshotEvent,
  ThreadVisitsChangedEvent,
]);
export type ThreadVisitsStreamEvent = typeof ThreadVisitsStreamEvent.Type;

export class ThreadVisitsError extends Schema.TaggedError<ThreadVisitsError>()(
  "ThreadVisitsError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}
