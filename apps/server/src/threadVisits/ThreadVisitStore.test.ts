import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ThreadVisit } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadVisitStore from "./ThreadVisitStore.ts";

const storeLayer = () => ThreadVisitStore.layer.pipe(Layer.provide(SqlitePersistenceMemory));

const threadId = ThreadId.make("thread-1");
const earlier = "2026-10-02T10:00:00.000Z";
const later = "2026-10-02T11:00:00.000Z";

const watchChanges = Effect.gen(function* () {
  const store = yield* ThreadVisitStore.ThreadVisitStore;
  const changes = yield* Queue.unbounded<ThreadVisit>();
  yield* store.streamChanges.pipe(
    Stream.runForEach((change) => Queue.offer(changes, change)),
    Effect.forkScoped({ startImmediately: true }),
  );
  return changes;
});

it.layer(NodeServices.layer)("ThreadVisitStore", (it) => {
  it.effect("a visit only moves the stored time forward", () =>
    Effect.gen(function* () {
      const store = yield* ThreadVisitStore.ThreadVisitStore;
      expect((yield* store.visit({ threadId, visitedAt: later })).visitedAt).toBe(later);
      const kept = yield* store.visit({ threadId, visitedAt: earlier });
      expect(kept).toMatchObject({ threadId, visitedAt: later, markedUnread: false });
      expect(yield* store.list).toHaveLength(1);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect(
    "mark-unread sets the time backwards and flags the row; a later visit clears the flag",
    () =>
      Effect.gen(function* () {
        const store = yield* ThreadVisitStore.ThreadVisitStore;
        yield* store.visit({ threadId, visitedAt: later });
        const unread = yield* store.markUnread({ threadId, visitedAt: earlier });
        expect(unread).toMatchObject({ visitedAt: earlier, markedUnread: true });
        const read = yield* store.visit({ threadId, visitedAt: later });
        expect(read).toMatchObject({ visitedAt: later, markedUnread: false });
        expect(yield* store.list).toEqual([read]);
      }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("publishes each change once, and nothing for a write that changes nothing", () =>
    Effect.gen(function* () {
      const store = yield* ThreadVisitStore.ThreadVisitStore;
      const changes = yield* watchChanges;
      yield* store.visit({ threadId, visitedAt: later });
      yield* store.visit({ threadId, visitedAt: earlier }); // no-op
      yield* store.visit({ threadId, visitedAt: later }); // no-op
      yield* store.markUnread({ threadId, visitedAt: earlier });
      yield* store.markUnread({ threadId, visitedAt: earlier }); // no-op

      expect(yield* Queue.take(changes)).toMatchObject({ visitedAt: later, markedUnread: false });
      expect(yield* Queue.take(changes)).toMatchObject({ visitedAt: earlier, markedUnread: true });
      expect(Option.isNone(yield* Queue.poll(changes))).toBe(true);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("normalizes times so the same instant in another format is a no-op", () =>
    Effect.gen(function* () {
      const store = yield* ThreadVisitStore.ThreadVisitStore;
      yield* store.visit({ threadId, visitedAt: "2026-10-02T07:00:00-04:00" });
      const again = yield* store.visit({ threadId, visitedAt: later });
      expect(again.visitedAt).toBe(later);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("rejects a visitedAt that is not a time", () =>
    Effect.gen(function* () {
      const store = yield* ThreadVisitStore.ThreadVisitStore;
      const error = yield* Effect.flip(store.visit({ threadId, visitedAt: "yesterday" }));
      expect(error._tag).toBe("ThreadVisitsError");
      expect(yield* store.list).toEqual([]);
    }).pipe(Effect.provide(storeLayer())),
  );
});
