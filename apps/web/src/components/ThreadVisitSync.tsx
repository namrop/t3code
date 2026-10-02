/**
 * Keeps the sidebar's last-viewed times in step with every connected server
 * that keeps them (fork feature, namrop/t3code: thread visits), so a thread
 * read on one device stops showing Done on the others without a reload.
 */
import type { EnvironmentId, ThreadVisit } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useServerConfigs } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { threadVisitsToMerge, threadVisitsToUpload } from "../state/threadVisits.logic";
import {
  sendThreadVisit,
  serverThreadVisitSink,
  threadVisitsEnvironment,
} from "../state/threadVisits";
import { setThreadVisitSink, useUiStateStore } from "../uiStateStore";

export function ThreadVisitSync() {
  const serverConfigs = useServerConfigs();
  const environmentIds = useMemo(
    () =>
      [...serverConfigs]
        .filter(([, config]) => config.environment.capabilities.threadVisits === true)
        .map(([environmentId]) => environmentId),
    [serverConfigs],
  );

  useEffect(() => {
    setThreadVisitSink(serverThreadVisitSink);
    return () => setThreadVisitSink(null);
  }, []);

  return (
    <>
      {environmentIds.map((environmentId) => (
        <ThreadVisitEnvironmentSync key={environmentId} environmentId={environmentId} />
      ))}
    </>
  );
}

function ThreadVisitEnvironmentSync({ environmentId }: { environmentId: EnvironmentId }) {
  const { data: state } = useEnvironmentQuery(
    threadVisitsEnvironment.visits({ environmentId, input: {} }),
  );
  // Rows already merged in this page, by thread key → the row's version.
  const merged = useRef(new Map<string, string>());
  const lastSnapshot = useRef<ReadonlyArray<ThreadVisit> | null>(null);

  useEffect(() => {
    if (state === null) return;
    const rows = threadVisitsToMerge(environmentId, state, merged.current);
    if (rows.length > 0) {
      useUiStateStore.getState().applyRemoteThreadVisits(rows);
      for (const row of rows) merged.current.set(row.threadKey, row.version);
    }
    // A new snapshot follows every (re)connect: send up whatever is newer here.
    if (state.snapshot === lastSnapshot.current) return;
    lastSnapshot.current = state.snapshot;
    const local = useUiStateStore.getState().threadLastVisitedAtById;
    for (const upload of threadVisitsToUpload(environmentId, state.byThreadId, local)) {
      sendThreadVisit("visit", environmentId, upload.threadId, upload.visitedAt);
    }
  }, [environmentId, state]);

  return null;
}
