import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("The orphan has no live provider process"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "orphaned-run-scar" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

// Strict expected failure: the live base refuses Stop after the provider disappears.
it.effect.fails("scar 01a1246d: Stop clears a running run whose provider session is gone", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:orphaned-run-scar");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("orphan:create"),
      threadId,
      projectId: ProjectId.make("project:orphaned-run-scar"),
      title: "Orphaned run",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("orphan:message"),
      threadId,
      messageId: MessageId.make("orphan:message"),
      text: "Continue where you left off.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const before = yield* projections.getThreadProjection(threadId);
    const run = before.runs[0]!;
    const node = before.nodes.find((candidate) => candidate.id === run.rootNodeId)!;
    const providerThread = before.providerThreads.find(
      (candidate) => candidate.id === run.providerThreadId,
    )!;
    const turnId = ProviderTurnId.make("turn:orphaned-run-scar");
    const attempt = before.attempts.find((candidate) => candidate.id === run.activeAttemptId)!;
    yield* projections.apply({
      id: EventId.make("orphan:attempt"),
      type: "run-attempt.updated",
      threadId,
      occurredAt: now,
      payload: { ...attempt, providerTurnId: turnId, status: "running" },
    });
    yield* projections.apply({
      id: EventId.make("orphan:running"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now },
    });
    yield* projections.apply({
      id: EventId.make("orphan:node"),
      type: "node.updated",
      threadId,
      occurredAt: now,
      payload: { ...node, status: "running" },
    });
    yield* projections.apply({
      id: EventId.make("orphan:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        ...providerThread,
        providerSessionId: ProviderSessionId.make("session:already-gone"),
      },
    });
    yield* projections.apply({
      id: EventId.make("orphan:provider-turn"),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: turnId,
        providerThreadId: providerThread.id,
        nodeId: node.id,
        runAttemptId: run.activeAttemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
    const orphan = yield* projections.getThreadProjection(threadId);
    assert.equal(orphan.runs[0]!.status, "running");
    assert.equal(orphan.providerTurns[0]!.status, "running");
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("orphan:stop"),
      threadId,
      runId: run.id,
      holdQueue: true,
    });
    const after = yield* projections.getThreadProjection(threadId);
    assert.equal(after.runs[0]!.status, "interrupted");
  }).pipe(Effect.provide(testLayer)),
);
