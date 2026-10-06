import {
  OpenClawSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import { makeOpenClawAdapterV2 } from "../../orchestration-v2/Adapters/OpenClawAdapterV2.ts";
import {
  buildOpenClawModelsFromConfigOptions,
  OPENCLAW_ACCESS_MODE_WARNING,
  OPENCLAW_DEFAULT_MODEL_SLUG,
  OPENCLAW_MODEL_CAPABILITIES,
  makeOpenClawAcpRuntime,
} from "../acp/OpenClawAcpSupport.ts";
import type { AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { ProviderDriverError } from "../Errors.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER = ProviderDriverKind.make("openclaw");
const decodeOpenClawSettings = Schema.decodeSync(OpenClawSettings);
const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: OPENCLAW_DEFAULT_MODEL_SLUG,
    name: "Default",
    isCustom: false,
    isDefault: true,
    capabilities: OPENCLAW_MODEL_CAPABILITIES,
  },
];
export type OpenClawDriverEnv =
  | Path.Path
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerConfig.ServerConfig
  | IdAllocator.IdAllocatorV2
  | ProviderEventLoggers.ProviderEventLoggers;

/** Dedicated legacy-compatible instance; discovery is cached per instance, not per session/auth id. */
export const OpenClawDriver: ProviderDriver<OpenClawSettings, OpenClawDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "OpenClaw", supportsMultipleInstances: true },
  configSchema: OpenClawSettings,
  defaultConfig: () => decodeOpenClawSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      const selfInvocation = yield* resolveSelfInvocation();
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const settings = { ...config, enabled };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stamp = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const checkedAt = yield* Clock.currentTimeMillis;
      const initial = stamp(
        buildServerProvider({
          driver: DRIVER,
          presentation: {
            displayName: "OpenClaw",
            badgeLabel: "Experimental",
            supportedRuntimeModes: [
              "approval-required",
              "auto-accept-edits",
              "auto",
              "full-access",
            ],
            requiresNewThreadForModelChange: false,
          },
          enabled,
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(checkedAt)),
          models: providerModelsFromSettings(
            FALLBACK_MODELS,
            settings.customModels,
            OPENCLAW_MODEL_CAPABILITIES,
          ),
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking OpenClaw Agent…",
          },
        }),
      );
      const snapshotRef = yield* Ref.make(initial);
      const changes = yield* PubSub.unbounded<ServerProvider>();
      let lastSuccessfulProbe = 0;
      const publish = (snapshot: ServerProvider) =>
        Ref.set(snapshotRef, snapshot).pipe(
          Effect.andThen(PubSub.publish(changes, snapshot)),
          Effect.asVoid,
        );
      const onSessionStarted = (started: AcpSessionRuntimeStartResult, discovery = false) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(snapshotRef);
          const now = yield* Clock.currentTimeMillis;
          // Only a fresh discovery session reports the configured agent default.
          // A loaded thread may have its own model pin, which is not a provider default.
          const models = discovery
            ? buildOpenClawModelsFromConfigOptions(started.sessionSetupResult.configOptions)
            : [];
          if (discovery) lastSuccessfulProbe = now;
          const supportsAccessModes =
            started.sessionSetupResult.configOptions?.some(
              (option) => option.id === "permission_mode" && option.type === "select",
            ) === true;
          yield* publish({
            ...current,
            installed: true,
            version: started.initializeResult.agentInfo?.version ?? current.version,
            status: !enabled ? "disabled" : supportsAccessModes ? "ready" : "warning",
            auth: { status: "authenticated" },
            checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
            message: supportsAccessModes ? undefined : OPENCLAW_ACCESS_MODE_WARNING,
            supportsAudioPrompts:
              started.initializeResult.agentCapabilities?.promptCapabilities?.audio === true,
            models: discovery
              ? providerModelsFromSettings(
                  models.length ? models : FALLBACK_MODELS,
                  settings.customModels,
                  OPENCLAW_MODEL_CAPABILITIES,
                )
              : current.models,
          });
        });
      const refresh = Effect.gen(function* () {
        if (
          !enabled ||
          (lastSuccessfulProbe > 0 &&
            (yield* Clock.currentTimeMillis) - lastSuccessfulProbe < 15 * 60 * 1000)
        )
          return yield* Ref.get(snapshotRef);
        yield* Effect.gen(function* () {
          const runtime = yield* makeOpenClawAcpRuntime({
            cwd: serverConfig.cwd,
            openclawSettings: settings,
            environment: processEnvironment,
            childProcessSpawner: spawner,
            clientInfo: { name: "t3-code-openclaw-model-probe", version: "0.0.0" },
            mcpServers: [],
          });
          const started = yield* runtime.start();
          yield* onSessionStarted(started, true);
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.scoped,
          Effect.timeout("30 seconds"),
          Effect.catch((error) =>
            Ref.get(snapshotRef).pipe(
              Effect.flatMap((current) =>
                publish({
                  ...current,
                  status: "warning",
                  message: `OpenClaw ACP discovery failed: ${String(error)}`,
                }),
              ),
            ),
          ),
        );
        return yield* Ref.get(snapshotRef);
      });
      yield* refresh.pipe(Effect.forkScoped);
      const unsupported = (operation: string) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "OpenClaw has no out-of-session text-generation API.",
          }),
        );
      return {
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        enabled,
        continuationIdentity,
        snapshot: {
          getSnapshot: Ref.get(snapshotRef),
          refresh,
          streamChanges: Stream.fromPubSub(changes),
          applyUsageLimits: () => Effect.void,
          resolveMaintenance: () =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: DRIVER,
                packageName: null,
              }),
            ),
        },
        refreshModels: () =>
          Effect.sync(() => {
            lastSuccessfulProbe = 0;
          }).pipe(Effect.andThen(refresh), Effect.asVoid),
        invalidateCaches: Effect.sync(() => {
          lastSuccessfulProbe = 0;
        }),
        orchestrationAdapter: makeOpenClawAdapterV2({
          instanceId,
          settings,
          environment: processEnvironment,
          crypto,
          fileSystem,
          idAllocator,
          serverConfig,
          selfInvocation,
          childProcessSpawner: spawner,
          onSessionStarted,
          nativeLogging: (threadId) =>
            makeNativeLogger({ nativeEventLogger: loggers.native, provider: DRIVER, threadId }),
        }),
        textGeneration: {
          generateCommitMessage: () => unsupported("generateCommitMessage"),
          generatePrContent: () => unsupported("generatePrContent"),
          generateBranchName: () => unsupported("generateBranchName"),
          generateThreadTitle: () => unsupported("generateThreadTitle"),
        },
      } satisfies ProviderInstance;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: "Could not prepare OpenClaw driver.",
            cause,
          }),
      ),
    ),
};
