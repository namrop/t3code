import {
  AtriumReadObjectError,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  WS_METHODS,
  type ServerConfig,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const UID = "01900000-0000-7000-8000-000000000001";
const ENVIRONMENT = EnvironmentId.make("atrium-environment");
const CONFIG = {
  settings: DEFAULT_SERVER_SETTINGS,
  environment: { serverVersion: "0.0.1", capabilities: {} },
} as ServerConfig;
const target = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const makeHarness = Effect.fn("ServerAtriumTest.makeHarness")(function* () {
  let generation = 1;
  let unavailable = false;
  const requests: Array<{ uid: string }> = [];
  const environmentsRead: EnvironmentId[] = [];
  const client = {
    [WS_METHODS.atriumReadObject]: (input: { uid: string }) =>
      Effect.suspend(() => {
        requests.push(input);
        return unavailable
          ? Effect.fail(new AtriumReadObjectError({ uid: input.uid, reason: "unavailable" }))
          : Effect.succeed({
              uid: input.uid,
              title: "Example object",
              path: "example/current.md",
              kind: "note",
              body: `Generation ${generation}`,
            });
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed(CONFIG),
    subscribeServerConfig: () => Stream.empty,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (environmentId, effect) => {
      environmentsRead.push(environmentId);
      return Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    },
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
      Layer.succeed(Persistence.EnvironmentCacheStore, cache),
    ),
  );
  const atoms = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => Atom.make(CONFIG),
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return {
    registry,
    requests,
    environmentsRead,
    read: atoms.readAtriumObject,
    setGeneration: (next: number) => {
      generation = next;
    },
    setUnavailable: (next: boolean) => {
      unavailable = next;
    },
  };
});

it.effect("reads the current object through the selected environment and refreshes by UID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const query = harness.read({ environmentId: ENVIRONMENT, input: { uid: UID } });
      harness.registry.mount(query);
      yield* AtomRegistry.toStream(harness.registry, query).pipe(
        Stream.filter(
          (result) =>
            AsyncResult.isSuccess(result) &&
            !result.waiting &&
            result.value.body === "Generation 1",
        ),
        Stream.runHead,
      );
      expect(harness.requests).toEqual([{ uid: UID }]);
      expect(harness.environmentsRead).toEqual([ENVIRONMENT]);
      harness.setGeneration(2);
      harness.registry.refresh(query);
      yield* AtomRegistry.toStream(harness.registry, query).pipe(
        Stream.filter(
          (result) =>
            AsyncResult.isSuccess(result) &&
            !result.waiting &&
            result.value.body === "Generation 2",
        ),
        Stream.runHead,
      );
      expect(harness.requests).toEqual([{ uid: UID }, { uid: UID }]);
    }),
  ),
);

it.effect("keeps object reads isolated by environment and UID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const input = { uid: UID };
      const first = harness.read({ environmentId: ENVIRONMENT, input });
      expect(harness.read({ environmentId: ENVIRONMENT, input: { ...input } })).toBe(first);
      expect(
        harness.read({ environmentId: EnvironmentId.make("other-environment"), input }),
      ).not.toBe(first);
      expect(
        harness.read({
          environmentId: ENVIRONMENT,
          input: { uid: "01900000-0000-7000-8000-000000000002" },
        }),
      ).not.toBe(first);
    }),
  ),
);

it.effect("exposes read failure and allows retry without losing the object identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.setUnavailable(true);
      const query = harness.read({ environmentId: ENVIRONMENT, input: { uid: UID } });
      harness.registry.mount(query);
      const result = yield* AtomRegistry.toStream(harness.registry, query).pipe(
        Stream.filter((result) => AsyncResult.isFailure(result) && !result.waiting),
        Stream.runHead,
      );
      expect(
        Option.isSome(result) &&
          result.value._tag === "Failure" &&
          String(Cause.squash(result.value.cause)),
      ).toContain("Atrium Service is unavailable");
      harness.setUnavailable(false);
      harness.registry.refresh(query);
      yield* AtomRegistry.toStream(harness.registry, query).pipe(
        Stream.filter((result) => AsyncResult.isSuccess(result) && !result.waiting),
        Stream.runHead,
      );
      expect(harness.requests).toEqual([{ uid: UID }, { uid: UID }]);
    }),
  ),
);
