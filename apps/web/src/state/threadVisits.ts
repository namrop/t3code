/**
 * Thread visits in the web app (fork feature, namrop/t3code): the server's
 * last-viewed times, and the path local visits take to reach it.
 */
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { createThreadVisitsEnvironmentAtoms } from "@t3tools/client-runtime/state/threadVisits";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { ThreadVisitSink } from "../uiStateStore";
import { environmentServerConfigsAtom } from "./server";

export const threadVisitsEnvironment = createThreadVisitsEnvironmentAtoms(connectionAtomRuntime);

/** Whether the environment's server keeps last-viewed times. Same version-skew
    contract as the pin and snooze flags: without it, times stay in this browser. */
export function readEnvironmentSupportsThreadVisits(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadVisits === true
  );
}

/** Send one write. Failures are dropped: the next snapshot re-sends any visit the server missed. */
export function sendThreadVisit(
  kind: "visit" | "markUnread",
  environmentId: EnvironmentId,
  threadId: ThreadId,
  visitedAt: string,
): void {
  if (!readEnvironmentSupportsThreadVisits(environmentId)) return;
  const command =
    kind === "visit" ? threadVisitsEnvironment.visit : threadVisitsEnvironment.markUnread;
  void runAtomCommand(
    appAtomRegistry,
    command,
    { environmentId, input: { threadId, visitedAt } },
    { reportFailure: false, reportDefect: false },
  );
}

const sendForThreadKey = (kind: "visit" | "markUnread", threadKey: string, visitedAt: string) => {
  const ref = parseScopedThreadKey(threadKey);
  if (ref === null) return;
  sendThreadVisit(kind, ref.environmentId, ref.threadId, visitedAt);
};

/** Installed in `uiStateStore` while the sync coordinator is mounted. */
export const serverThreadVisitSink: ThreadVisitSink = {
  visit: (threadKey, visitedAt) => sendForThreadKey("visit", threadKey, visitedAt),
  markUnread: (threadKey, visitedAt) => sendForThreadKey("markUnread", threadKey, visitedAt),
};
