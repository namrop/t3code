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
import { makeOpenClawAcpRuntime } from "../../provider/acp/OpenClawAcpSupport.ts";
import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import { normalizeOpenClawToolCall, projectOpenClawToolCall } from "./OpenClawAcp.ts";
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
      tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: false },
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
    // Model and access config-option selection are added at this flavor seam.
    applyModelSelection: () => Effect.succeed(undefined),
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
