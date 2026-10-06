import {
  type HermesSettings,
  ProviderDriverKind,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, normalizeModelSlug } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Crypto from "effect/Crypto";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as AcpSchema from "effect-acp/compat";
import * as AcpErrors from "effect-acp/errors";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const HERMES_DEFAULT_MODEL_SLUG = "hermes-agent";
export const HERMES_CANCEL_TIMEOUT_MS = 30_000;
const DRIVER = ProviderDriverKind.make("hermes");
export const HERMES_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

export function buildHermesAcpSpawnInput(
  settings: Partial<Pick<HermesSettings, "binaryPath" | "homePath">> | null | undefined,
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
): AcpSessionRuntime.AcpSpawnInput {
  const env = { ...environment };
  delete env.HERMES_HOME;
  const home = settings?.homePath?.trim();
  if (home) env.HERMES_HOME = home;
  return { command: settings?.binaryPath || "hermes", args: ["acp"], cwd, env, extendEnv: false };
}

export function resolveHermesAcpModeId(mode: RuntimeMode | undefined): string {
  switch (mode) {
    case "approval-required":
      return "supervised";
    case "auto":
    case "full-access":
      return "dont_ask";
    case "auto-accept-edits":
      return "accept_edits";
    default:
      return "default";
  }
}

export function resolveHermesAcpBaseModelId(model: string | null | undefined): string {
  return (
    normalizeModelSlug(model?.trim() || HERMES_DEFAULT_MODEL_SLUG, DRIVER) ??
    HERMES_DEFAULT_MODEL_SLUG
  );
}

export function buildHermesModelsFromSessionModelState(
  state: AcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return (state?.availableModels ?? []).flatMap((model) => {
    const slug = resolveHermesAcpBaseModelId(model.modelId);
    if (seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        ...(model.modelId.trim() === state?.currentModelId.trim() ? { isDefault: true } : {}),
        capabilities: HERMES_MODEL_CAPABILITIES,
      },
    ];
  });
}

export function applyHermesAcpModelSelection(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly defaultModelId?: string;
}): Effect.Effect<string | undefined, AcpErrors.AcpError> {
  const isDefault =
    input.requestedModelId === undefined ||
    [HERMES_DEFAULT_MODEL_SLUG, "default", "auto", ""].includes(input.requestedModelId);
  const requested = isDefault ? input.defaultModelId : input.requestedModelId;
  if (requested === undefined) {
    return Effect.fail(
      new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage:
          "Hermes configured default model has not been discovered; keeping the session's current model.",
      }),
    );
  }
  return requested === input.currentModelId
    ? Effect.succeed(input.currentModelId)
    : input.runtime.setSessionModel(requested).pipe(Effect.as(requested));
}

/** Upstream selects the live initialize auth method after auth-required: no stale global auth cache or extra cold process. */
export function makeHermesAcpRuntime(
  input: Omit<AcpSessionRuntime.AcpSessionRuntimeOptions, "spawn"> & {
    readonly hermesSettings: HermesSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  },
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  AcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  return Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        onResumeNotFound: "new-session",
        cancelBehavior: "wait-for-prompt",
        cancelTimeout: `${HERMES_CANCEL_TIMEOUT_MS} millis`,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(context),
    );
    return runtime;
  });
}
