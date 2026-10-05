import {
  type HermesSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/process";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import type { ServerConfig } from "../../config.ts";
import type { IdAllocatorV2 } from "../IdAllocator.ts";
import {
  applyHermesAcpModelSelection,
  makeHermesAcpRuntime,
  resolveHermesAcpBaseModelId,
  resolveHermesAcpModeId,
} from "../../provider/acp/HermesAcpSupport.ts";
import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import { acpPermissionDisposition } from "../../provider/acp/AcpClientPolicy.ts";
import {
  extractHermesSubagentUpdate,
  normalizeHermesToolCall,
  projectHermesToolCall,
} from "./HermesAcp.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "./AcpAdapterV2.ts";

export interface HermesAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: HermesSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly selfInvocation: SelfInvocation;
  readonly serverConfig: ServerConfig["Service"];
  readonly makeRuntime?: AcpAdapterV2Flavor["makeRuntime"];
  readonly onSessionStarted?: (
    result: AcpSessionRuntime.AcpSessionRuntimeStartResult,
  ) => Effect.Effect<void>;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
}

export function makeHermesAcpAdapterFlavor(options: HermesAdapterV2Options): AcpAdapterV2Flavor {
  const currentModels = new WeakMap<AcpSessionRuntime.AcpSessionRuntime["Service"], string>();
  return {
    driver: ProviderDriverKind.make("hermes"),
    runtimeHarness: "Hermes",
    capabilities: {
      ...AcpProviderCapabilitiesV2,
      sessions: {
        ...AcpProviderCapabilitiesV2.sessions,
        supportsModelSwitchInSession: true,
        supportsRuntimeModeSwitchInSession: true,
      },
      tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: true },
      subagents: { ...AcpProviderCapabilitiesV2.subagents, supportsSubagents: true },
    },
    makeRuntime:
      options.makeRuntime ??
      ((input) =>
        makeHermesAcpRuntime({
          ...input,
          hermesSettings: options.settings,
          environment: { ...options.environment, ...input.processEnvironment },
          childProcessSpawner: options.childProcessSpawner,
        }).pipe(
          Effect.map((runtime) => ({
            ...runtime,
            start: () =>
              runtime
                .start()
                .pipe(Effect.tap((started) => options.onSessionStarted?.(started) ?? Effect.void)),
          })),
        )),
    applyModelSelection: ({ runtime, startResult, modelSelection }) =>
      applyHermesAcpModelSelection({
        runtime,
        currentModelId:
          currentModels.get(runtime) ??
          startResult.sessionSetupResult.models?.currentModelId ??
          undefined,
        requestedModelId: resolveHermesAcpBaseModelId(modelSelection.model),
      }).pipe(
        Effect.tap((selected) =>
          Effect.sync(() => {
            if (selected !== undefined) currentModels.set(runtime, selected);
          }),
        ),
      ),
    sessionModeForPolicy: (policy) => resolveHermesAcpModeId(policy.runtimeMode),
    // Auto means Hermes's own classifier. Anything it still asks about must
    // reach the user; only Full access may bypass that last approval gate.
    permissionDisposition: (policy, request) =>
      policy.runtimeMode === "auto" ? "ask" : acpPermissionDisposition(policy, request),
    normalizeToolCall: normalizeHermesToolCall,
    projectToolCall: projectHermesToolCall,
    extractSubagentUpdate: extractHermesSubagentUpdate,
    supportsImagePrompts: true,
  };
}

export function makeHermesAdapterV2(options: HermesAdapterV2Options) {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeHermesAcpAdapterFlavor(options),
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging ? { nativeLogging: options.nativeLogging } : {}),
  });
}
