import { EMPTY_THREAD_VISITS } from "@t3tools/client-runtime/state/threadVisits";
import { EnvironmentId, ThreadId, type ThreadVisit } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadVisitsToMerge, threadVisitsToUpload } from "./threadVisits.logic";

const environmentId = EnvironmentId.make("env-1");
const row = (
  threadId: string,
  visitedAt: string,
  updatedAt: string,
  markedUnread = false,
): ThreadVisit => ({ threadId: ThreadId.make(threadId), visitedAt, markedUnread, updatedAt });

const stateOf = (visits: ThreadVisit[]) => ({
  byThreadId: Object.fromEntries(visits.map((visit) => [visit.threadId, visit])),
  snapshot: visits,
});

describe("threadVisitsToMerge", () => {
  it("returns rows not merged yet, keyed for the local store, and skips rows already merged", () => {
    const a = row("thread-a", "2026-10-02T10:00:00.000Z", "2026-10-02T10:00:01.000Z", true);
    const b = row("thread-b", "2026-10-02T11:00:00.000Z", "2026-10-02T11:00:01.000Z");
    const merged = new Map([["env-1:thread-a", a.updatedAt]]);
    expect(threadVisitsToMerge(environmentId, stateOf([a, b]), merged)).toEqual([
      {
        threadKey: "env-1:thread-b",
        visitedAt: b.visitedAt,
        markedUnread: false,
        updatedAt: b.updatedAt,
      },
    ]);
    expect(threadVisitsToMerge(environmentId, EMPTY_THREAD_VISITS, merged)).toEqual([]);
  });
});

describe("threadVisitsToUpload", () => {
  it("sends local times in this environment that the server lacks or has earlier", () => {
    const server = stateOf([
      row("thread-same", "2026-10-02T10:00:00.000Z", "x"),
      row("thread-behind", "2026-10-02T09:00:00.000Z", "x"),
      row("thread-ahead", "2026-10-02T12:00:00.000Z", "x"),
    ]).byThreadId;
    const local = {
      "env-1:thread-same": "2026-10-02T10:00:00.000Z",
      "env-1:thread-behind": "2026-10-02T10:00:00.000Z",
      "env-1:thread-ahead": "2026-10-02T10:00:00.000Z",
      "env-1:thread-new": "2026-10-02T08:00:00.000Z",
      "env-2:thread-other": "2026-10-02T08:00:00.000Z",
      "env-1:thread-bad": "not a time",
      "not-a-key": "2026-10-02T08:00:00.000Z",
    };
    expect(threadVisitsToUpload(environmentId, server, local)).toEqual([
      { threadId: "thread-behind", visitedAt: "2026-10-02T10:00:00.000Z" },
      { threadId: "thread-new", visitedAt: "2026-10-02T08:00:00.000Z" },
    ]);
  });
});
