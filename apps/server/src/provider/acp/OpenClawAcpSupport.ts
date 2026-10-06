import {
  type OpenClawSettings,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as AcpSchema from "effect-acp/compat";
import type * as AcpErrors from "effect-acp/errors";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const OPENCLAW_DEFAULT_MODEL_SLUG = "openclaw-default";
export const OPENCLAW_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

export function buildOpenClawAcpSpawnInput(
  settings: Partial<Pick<OpenClawSettings, "binaryPath">> | null | undefined,
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "openclaw",
    args: ["acp"],
    cwd,
    env: { ...environment, OPENCLAW_HIDE_BANNER: "1", OPENCLAW_SUPPRESS_NOTES: "1" },
    extendEnv: false,
  };
}

/** Config-option models use exact gateway provider/model refs, not legacy ACP model IDs. */
export function buildOpenClawModelsFromConfigOptions(
  options: ReadonlyArray<AcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const modelOption =
    options?.find((option) => option.id === "model" && option.type === "select") ??
    options?.find((option) => option.category === "model" && option.type === "select");
  if (!modelOption || modelOption.type !== "select") return [];
  const seen = new Set<string>();
  const choices = modelOption.options.flatMap((option) =>
    "groupId" in option ? option.options : [option],
  );
  if (
    modelOption.currentValue &&
    !choices.some((option) => option.value === modelOption.currentValue)
  ) {
    choices.push({ value: modelOption.currentValue, name: modelOption.currentValue });
  }
  return choices.flatMap((option) => {
    if (seen.has(option.value)) return [];
    seen.add(option.value);
    return [
      {
        slug: option.value,
        name: option.name,
        isCustom: false,
        ...(option.value === modelOption.currentValue ? { isDefault: true } : {}),
        capabilities: OPENCLAW_MODEL_CAPABILITIES,
      },
    ];
  });
}

export function resolveOpenClawPermissionMode(mode: RuntimeMode): string {
  switch (mode) {
    case "full-access":
      return "full";
    case "auto":
      return "workspace";
    default:
      return "guarded";
  }
}

/** Read live config state so A -> B -> A switches and loaded sessions stay accurate. */
export function applyOpenClawAcpModelSelection(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly requestedModelId: string;
}): Effect.Effect<string | undefined, AcpErrors.AcpError> {
  return Effect.gen(function* () {
    const options = yield* input.runtime.getConfigOptions;
    const model = options.find((option) => option.id === "model" && option.type === "select");
    if (model?.type !== "select") return undefined;
    if (
      [OPENCLAW_DEFAULT_MODEL_SLUG, "default", "auto", ""].includes(input.requestedModelId) ||
      model.currentValue === input.requestedModelId
    ) {
      return model.currentValue;
    }
    yield* input.runtime.setConfigOption(model.id, input.requestedModelId);
    return input.requestedModelId;
  });
}

export function makeOpenClawAcpRuntime(
  input: Omit<AcpSessionRuntime.AcpSessionRuntimeOptions, "spawn"> & {
    readonly openclawSettings: OpenClawSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  },
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  AcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  return AcpSessionRuntime.make({
    ...input,
    spawn: buildOpenClawAcpSpawnInput(input.openclawSettings, input.cwd, input.environment),
    onResumeNotFound: "new-session",
    cancelBehavior: "wait-for-prompt",
    cancelTimeout: "30 seconds",
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
  );
}
