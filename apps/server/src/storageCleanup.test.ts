import { describe, expect, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/process";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { make, storageCleanupActivityAt, storageCleanupThreadIdle } from "./storageCleanup.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), activeRunId: RunId.make("run") }, NOW_MS),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), latestUserMessageAt: at(-1_000) }, NOW_MS),
    ).toBe(false);
  });

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

describe("native storage cleanup service ownership exclusion", () => {
  it.effect.each(["physical", "published", "marker", "malformed-marker"])(
    "skips %s owned candidates before Git mutation while cleaning adjacent legacy worktrees",
    (kind) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-owned-" });
        const legacyRoot = path.join(root, "worktrees");
        const physicalRoot = path.join(legacyRoot, "physical");
        const publishedRoot = path.join(legacyRoot, "published");
        const owned = path.join(
          legacyRoot,
          kind === "physical" || kind === "published" ? kind : "stale",
          "repo",
        );
        const legacy = path.join(legacyRoot, "legacy", "repo");
        for (const directory of [owned, legacy]) {
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.writeFileString(path.join(directory, ".git"), "gitdir: fixture\n");
        }
        if (kind.includes("marker")) {
          yield* fs.writeFileString(
            path.join(owned, ".pharos-owned-worktree.json"),
            kind === "marker" ? '{"schemaVersion":1}' : "broken",
          );
        }
        const removed: string[] = [];
        const inspected: string[] = [];
        const threads = [owned, legacy].map((worktreePath, index) =>
          shell({ id: ThreadId.make(`cleanup-${index}`), branch: "feature", worktreePath }),
        );
        const configLayer = Layer.effect(
          ServerConfig.ServerConfig,
          Effect.map(ServerConfig.ServerConfig, (config) => ({
            ...config,
            worktreesDir: legacyRoot,
            ownedWorktrees: {
              physicalRoot,
              publishedRoot,
              producerCommand: "/fixture/producer",
              manifest: "/fixture/manifest",
              homeId: "work",
              cacheHomeId: "cache",
              owner: "fixture",
              sourceCommonDir: "/fixture/.git",
            },
          })),
        ).pipe(Layer.provide(ServerConfig.layerTest(root, path.join(root, "state"))));
        const service = yield* make.pipe(
          Effect.provide(
            Layer.mergeAll(
              configLayer,
              Settings.layerTest({
                worktreeCleanup: {
                  mode: "custom",
                  rules: {
                    worktreeAfterDays: 1,
                    worktreeOnMerge: false,
                    worktreeOnDelete: false,
                    worktreeUnchanged: false,
                  },
                },
              }),
              Layer.mock(ProjectStore.ProjectStoreV2)({
                listShells: () =>
                  Effect.succeed([
                    {
                      id: ProjectId.make("project-1"),
                      title: "Fixture",
                      defaultModelSelection: null,
                      scripts: [],
                      createdAt: "2026-01-01T00:00:00.000Z",
                      updatedAt: "2026-01-01T00:00:00.000Z",
                      workspaceRoot: path.join(root, "main"),
                    },
                  ]),
              }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getShellSnapshot: (options) =>
                  Effect.succeed({
                    schemaVersion: 1,
                    snapshotSequence: 0,
                    archivedThreads: [],
                    threads: options?.location === "archive" ? [] : threads,
                  }),
              }),
              Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
              Layer.mock(TerminalManager.TerminalManager)({
                subscribeMetadata: () => Effect.succeed(() => {}),
              }),
              Layer.mock(GitManager.GitManager)({ invalidateStatus: () => Effect.void }),
              Layer.mock(GitVcsDriver.GitVcsDriver)({
                statusDetailsLocal: (cwd) => {
                  inspected.push(cwd);
                  return Effect.succeed({
                    isRepo: true,
                    branch: "feature",
                    hasWorkingTreeChanges: false,
                    hasOriginRemote: false,
                    isDefaultBranch: false,
                    upstreamRef: null,
                    workingTree: { files: [], insertions: 0, deletions: 0 },
                    hasUpstream: false,
                    aheadCount: 0,
                    behindCount: 0,
                    aheadOfDefaultCount: 0,
                  });
                },
                resolveCommit: () => Effect.succeed({ commitSha: "abc" }),
                execute: () =>
                  Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: "",
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  }),
                removeWorktree: (input) =>
                  Effect.sync(() => {
                    removed.push(input.path);
                  }),
              }),
            ),
          ),
        );
        yield* service.start();
        yield* Effect.yieldNow;
        yield* service.drain;
        expect(removed).toEqual([legacy]);
        expect(inspected).not.toContain(owned);
      }).pipe(
        Effect.scoped,
        Effect.provide(SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
  );
});
