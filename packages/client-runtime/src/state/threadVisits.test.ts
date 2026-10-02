import { ThreadId, type ThreadVisit } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { applyThreadVisitsStreamEvent, EMPTY_THREAD_VISITS } from "./threadVisits.ts";

const row = (threadId: string, visitedAt: string, markedUnread = false): ThreadVisit => ({
  threadId: ThreadId.make(threadId),
  visitedAt,
  markedUnread,
  updatedAt: visitedAt,
});

describe("applyThreadVisitsStreamEvent", () => {
  it("takes the snapshot, then each changed row, keeping the snapshot's identity", () => {
    const a = row("thread-a", "2026-10-02T10:00:00.000Z");
    const b = row("thread-b", "2026-10-02T10:05:00.000Z");
    const visits = [a, b];
    const loaded = applyThreadVisitsStreamEvent(EMPTY_THREAD_VISITS, { type: "snapshot", visits });
    expect(loaded.byThreadId).toEqual({ "thread-a": a, "thread-b": b });
    expect(loaded.snapshot).toBe(visits);

    const aUnread = row("thread-a", "2026-10-02T09:59:59.999Z", true);
    const changed = applyThreadVisitsStreamEvent(loaded, { type: "changed", visit: aUnread });
    expect(changed.byThreadId).toEqual({ "thread-a": aUnread, "thread-b": b });
    expect(changed.snapshot).toBe(visits);
  });

  it("lets a later snapshot (after a reconnect) replace rows it no longer has", () => {
    const stale = applyThreadVisitsStreamEvent(EMPTY_THREAD_VISITS, {
      type: "changed",
      visit: row("thread-gone", "2026-10-02T10:00:00.000Z"),
    });
    const fresh = [row("thread-a", "2026-10-02T11:00:00.000Z")];
    const reloaded = applyThreadVisitsStreamEvent(stale, { type: "snapshot", visits: fresh });
    expect(reloaded.byThreadId).toEqual({ "thread-a": fresh[0] });
    expect(reloaded.snapshot).toBe(fresh);
  });
});
