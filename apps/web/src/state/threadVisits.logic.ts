/**
 * Pure rules for syncing the sidebar's last-viewed times with a server that
 * keeps them (fork feature, namrop/t3code: thread visits).
 *
 * The browser still reads `threadLastVisitedAtById` in `uiStateStore`; these
 * rules decide which server rows to merge into it and which local times to
 * send up after a (re)connect.
 */
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ThreadVisitsState } from "@t3tools/client-runtime/state/threadVisits";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { RemoteThreadVisit } from "../uiStateStore";

export interface ThreadVisitToMerge extends RemoteThreadVisit {
  /** Identifies this version of the row, remembered so it is not merged twice. */
  readonly version: string;
}

/**
 * A row's version: its change time and its content, so two writes that land
 * in the same millisecond are still told apart.
 */
export function threadVisitVersion(visit: {
  readonly updatedAt: string;
  readonly visitedAt: string;
  readonly markedUnread: boolean;
}): string {
  return `${visit.updatedAt}|${visit.visitedAt}|${visit.markedUnread ? "unread" : "visit"}`;
}

/**
 * Server rows this page has not merged yet, keyed for the local store.
 * `merged` holds the version of each row already merged, by thread key.
 * A row merged once is never replayed, so an old mark-unread cannot undo a
 * newer local visit after a reconnect.
 */
export function threadVisitsToMerge(
  environmentId: EnvironmentId,
  state: ThreadVisitsState,
  merged: ReadonlyMap<string, string>,
): ReadonlyArray<ThreadVisitToMerge> {
  const rows: ThreadVisitToMerge[] = [];
  for (const visit of Object.values(state.byThreadId)) {
    const threadKey = scopedThreadKey({ environmentId, threadId: visit.threadId });
    const version = threadVisitVersion(visit);
    if (merged.get(threadKey) === version) continue;
    rows.push({
      threadKey,
      visitedAt: visit.visitedAt,
      markedUnread: visit.markedUnread,
      version,
    });
  }
  return rows;
}

/**
 * Local times in this environment that are later than the server's, or that
 * the server has no row for. Sent as visits after each snapshot (that is,
 * after every connect): the first time this carries the browser's existing
 * records up, and afterwards it re-sends any visit made while disconnected.
 * Run after merging the snapshot, so a mark-unread from another device has
 * already lowered the local time and is not overwritten.
 */
export function threadVisitsToUpload(
  environmentId: EnvironmentId,
  serverByThreadId: ThreadVisitsState["byThreadId"],
  local: Readonly<Record<string, string>>,
): ReadonlyArray<{ readonly threadId: ThreadId; readonly visitedAt: string }> {
  const uploads: Array<{ readonly threadId: ThreadId; readonly visitedAt: string }> = [];
  for (const [threadKey, visitedAt] of Object.entries(local)) {
    const ref = parseScopedThreadKey(threadKey);
    if (ref === null || ref.environmentId !== environmentId) continue;
    const localMs = Date.parse(visitedAt);
    if (!Number.isFinite(localMs)) continue;
    const server = serverByThreadId[ref.threadId];
    if (server !== undefined) {
      const serverMs = Date.parse(server.visitedAt);
      if (Number.isFinite(serverMs) && serverMs >= localMs) continue;
    }
    uploads.push({ threadId: ref.threadId, visitedAt });
  }
  return uploads;
}
