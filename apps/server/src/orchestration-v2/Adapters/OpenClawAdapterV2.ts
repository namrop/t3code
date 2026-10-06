import {
  type OpenClawSettings,
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
  applyOpenClawAcpModelSelection,
  makeOpenClawAcpRuntime,
  resolveOpenClawPermissionMode,
} from "../../provider/acp/OpenClawAcpSupport.ts";
import { acpPermissionDisposition } from "../../provider/acp/AcpClientPolicy.ts";
import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import {
  extractOpenClawSubagentUpdate,
  normalizeOpenClawToolCall,
  projectOpenClawToolCall,
} from "./OpenClawAcp.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "./AcpAdapterV2.ts";

export interface OpenClawAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OpenClawSettings;
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

export function makeOpenClawAcpAdapterFlavor(
  options: OpenClawAdapterV2Options,
): AcpAdapterV2Flavor {
  return {
    driver: ProviderDriverKind.make("openclaw"),
    runtimeHarness: "OpenClaw",
    capabilities: {
      ...AcpProviderCapabilitiesV2,
      sessions: {
        ...AcpProviderCapabilitiesV2.sessions,
        supportsModelSwitchInSession: true,
        supportsRuntimeModeSwitchInSession: true,
      },
      tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: false },
      subagents: { ...AcpProviderCapabilitiesV2.subagents, supportsSubagents: true },
    },
    omitMcpServers: true,
    sessionRequestMeta: (threadId) =>
      threadId === null
        ? undefined
        : {
            sessionKey: `agent:${options.settings.agentId || "main"}:t3:${threadId}`,
          },
    makeRuntime:
      options.makeRuntime ??
      ((input) =>
        makeOpenClawAcpRuntime({
          ...input,
          openclawSettings: options.settings,
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
    applyModelSelection: ({ runtime, modelSelection }) =>
      applyOpenClawAcpModelSelection({ runtime, requestedModelId: modelSelection.model }),
    applyRuntimePolicy: ({ runtime, policy }) =>
      Effect.gen(function* () {
        const options = yield* runtime.getConfigOptions;
        const access = options.find(
          (option) => option.id === "permission_mode" && option.type === "select",
        );
        const value = resolveOpenClawPermissionMode(policy.runtimeMode);
        if (access?.type === "select" && access.currentValue !== value) {
          yield* runtime.setConfigOption(access.id, value);
        }
      }),
    // OpenClaw's classifier owns Auto. Requests it still makes must reach the user.
    permissionDisposition: (policy, request) =>
      policy.runtimeMode === "auto" ? "ask" : acpPermissionDisposition(policy, request),
    extractSubagentUpdate: extractOpenClawSubagentUpdate,
    // Keep the subscriber and child lineage alive after session/prompt returns,
    // including nested spawns arriving after their parent's spawn tool settled.
    deferFinalizeForBackgroundWork: true,
    normalizeToolCall: normalizeOpenClawToolCall,
    projectToolCall: projectOpenClawToolCall,
    supportsImagePrompts: true,
  };
}

export function makeOpenClawAdapterV2(options: OpenClawAdapterV2Options) {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeOpenClawAcpAdapterFlavor(options),
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging ? { nativeLogging: options.nativeLogging } : {}),
  });
}
