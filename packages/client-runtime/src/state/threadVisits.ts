/**
 * Thread visits: when each thread was last viewed, as the server keeps it.
 *
 * Fork feature (namrop/t3code). The server streams one snapshot of every row,
 * then each changed row; this module folds that into a map by thread id and
 * exposes the two writes. Servers advertise it with the `threadVisits`
 * capability; clients must not subscribe to servers without it.
 *
 * @module threadVisits
 */
import type { ThreadVisit, ThreadVisitsStreamEvent } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** The server's rows for one environment. */
export interface ThreadVisitsState {
  /** Every row, by thread id. */
  readonly byThreadId: Readonly<Record<string, ThreadVisit>>;
  /**
   * The rows of the latest snapshot. A new array arrives on every (re)connect,
   * so a consumer can tell a fresh snapshot from a change by reference, even
   * though a reconnect restarts this fold from empty.
   */
  readonly snapshot: ReadonlyArray<ThreadVisit>;
}

export const EMPTY_THREAD_VISITS: ThreadVisitsState = { byThreadId: {}, snapshot: [] };

/** A snapshot replaces every row (it follows every reconnect); a change upserts one. */
export function applyThreadVisitsStreamEvent(
  current: ThreadVisitsState,
  event: ThreadVisitsStreamEvent,
): ThreadVisitsState {
  switch (event.type) {
    case "snapshot":
      return {
        byThreadId: Object.fromEntries(event.visits.map((visit) => [visit.threadId, visit])),
        snapshot: event.visits,
      };
    case "changed":
      return {
        byThreadId: { ...current.byThreadId, [event.visit.threadId]: event.visit },
        snapshot: current.snapshot,
      };
  }
}

export function createThreadVisitsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // One FIFO lane per environment for both writes, so a visit and a later
  // mark-unread reach the server in the order they were made.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    /** Every row on the server, kept current. Empty until the first snapshot arrives. */
    visits: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:thread-visits",
      tag: WS_METHODS.subscribeThreadVisits,
      transform: (stream) =>
        stream.pipe(
          Stream.mapAccum(
            () => EMPTY_THREAD_VISITS,
            (current, event) => {
              const next = applyThreadVisitsStreamEvent(current, event);
              return [next, [next]] as const;
            },
          ),
        ),
    }),
    /** Record a visit; the server keeps the later of its time and this one. */
    visit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-visits:visit",
      tag: WS_METHODS.threadVisitsVisit,
      scheduler,
      concurrency,
    }),
    /** Mark a thread unread; the server stores this time exactly. */
    markUnread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-visits:mark-unread",
      tag: WS_METHODS.threadVisitsMarkUnread,
      scheduler,
      concurrency,
    }),
  };
}
