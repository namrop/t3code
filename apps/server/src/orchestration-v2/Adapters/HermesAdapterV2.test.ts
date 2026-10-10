import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  buildHermesAcpSpawnInput,
  resolveHermesAcpModeId,
  applyHermesAcpModelSelection,
  buildHermesModelCapabilities,
  buildHermesModelsFromSessionModelState,
} from "../../provider/acp/HermesAcpSupport.ts";
import {
  normalizeHermesToolCall,
  extractHermesSubagentUpdate,
  projectHermesToolCall,
} from "./HermesAcp.ts";
import { makeHermesAcpAdapterFlavor } from "./HermesAdapterV2.ts";
import type { AcpToolCallState } from "../../provider/acp/AcpRuntimeModel.ts";

describe("Hermes ACP compatibility", () => {
  it.effect("Default restores fresh discovery rather than a loaded session override", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let defaultModel = "anthropic:configured";
      const runtime = {
        setSessionModel: (id: string) =>
          Effect.sync(() => {
            calls.push(id);
            return {};
          }),
      } as never;
      const flavor = makeHermesAcpAdapterFlavor({
        defaultModel: Effect.sync(() => defaultModel),
      } as never);
      const apply = (model: string) =>
        flavor.applyModelSelection!({
          runtime,
          startResult: {
            sessionSetupResult: { models: { currentModelId: "openai:loaded-override" } },
          } as never,
          modelSelection: { instanceId: "hermes" as never, model },
        });
      expect(yield* apply("hermes-agent")).toBe("anthropic:configured");
      yield* apply("custom:unlisted");
      defaultModel = "anthropic:new-default";
      expect(yield* apply("hermes-agent")).toBe("anthropic:new-default");
      expect(calls).toEqual(["anthropic:configured", "custom:unlisted", "anthropic:new-default"]);
    }),
  );
  it.effect("switches back to the original model after an in-session switch", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const runtime = {
        setSessionModel: (id: string) =>
          Effect.sync(() => {
            calls.push(id);
            return {};
          }),
      } as never;
      const flavor = makeHermesAcpAdapterFlavor({} as never);
      const apply = (model: string) =>
        flavor.applyModelSelection!({
          runtime,
          startResult: {
            sessionSetupResult: { models: { currentModelId: "anthropic:original" } },
          } as never,
          modelSelection: { instanceId: "hermes" as never, model },
        });
      yield* apply("openai-codex:other");
      yield* apply("anthropic:original");
      expect(calls).toEqual(["openai-codex:other", "anthropic:original"]);
    }),
  );

  it("uses the configured Hermes home, never the server's ambient home", () => {
    expect(
      buildHermesAcpSpawnInput({ binaryPath: "/bin/hermes", homePath: "" }, "/repo", {
        HERMES_HOME: "/wrong",
        PATH: "/bin",
      }),
    ).toMatchObject({
      command: "/bin/hermes",
      args: ["acp"],
      env: { PATH: "/bin" },
      extendEnv: false,
    });
    expect(
      buildHermesAcpSpawnInput({ homePath: "/right" }, "/repo", { HERMES_HOME: "/wrong" }).env
        ?.HERMES_HOME,
    ).toBe("/right");
  });
  it("maps all T3 runtime modes to Hermes approval modes", () => {
    expect(
      ["approval-required", "auto", "auto-accept-edits", "full-access"].map((mode) =>
        resolveHermesAcpModeId(mode as Parameters<typeof resolveHermesAcpModeId>[0]),
      ),
    ).toEqual(["supervised", "dont_ask", "accept_edits", "dont_ask"]);
  });
  it("offers Hermes's reasoning setting as a model option and leaves its mode to the runtime mode", () => {
    const capabilities = buildHermesModelCapabilities([
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "default",
        options: [
          { value: "default", name: "Default" },
          { value: "supervised", name: "Supervised" },
        ],
      },
      {
        id: "reasoning",
        name: "Reasoning",
        description: "Reasoning effort for this session.",
        category: "thought_level",
        type: "select",
        currentValue: "default",
        options: [
          { value: "default", name: "Default (xhigh)" },
          { value: "none", name: "Off" },
          { value: "low", name: "Low" },
          { value: "xhigh", name: "Extra high" },
        ],
      },
    ]);
    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoning",
        label: "Reasoning",
        description: "Reasoning effort for this session.",
        type: "select",
        currentValue: "default",
        options: [
          { id: "default", label: "Default (xhigh)" },
          { id: "none", label: "Off" },
          { id: "low", label: "Low" },
          { id: "xhigh", label: "Extra high" },
        ],
      },
    ]);
    // A Hermes without the setting (older build) offers no controls, as before.
    expect(buildHermesModelCapabilities(undefined).optionDescriptors).toEqual([]);
    const [model] = buildHermesModelsFromSessionModelState(
      {
        currentModelId: "anthropic:claude-opus-5-5",
        availableModels: [{ modelId: "anthropic:claude-opus-5-5", name: "Opus" }],
      },
      capabilities,
    );
    expect(model?.capabilities).toEqual(capabilities);
  });
  it("keeps colon model ids and marks the native current model default", () => {
    expect(
      buildHermesModelsFromSessionModelState({
        currentModelId: "anthropic:claude-opus-5-5",
        availableModels: [
          { modelId: "anthropic:claude-opus-5-5", name: "Opus" },
          { modelId: "openai-codex:gpt-6-luna", name: "Luna" },
        ],
      }).map((model) => [model.slug, model.isDefault]),
    ).toEqual([
      ["anthropic:claude-opus-5-5", true],
      ["openai-codex:gpt-6-luna", undefined],
    ]);
  });
});
it.effect("switches legacy models with session/set_model and resolves Default from discovery", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const runtime = {
      setSessionModel: (model: string) =>
        Effect.sync(() => {
          calls.push(model);
          return {};
        }),
    };
    expect(
      yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "A",
        requestedModelId: "hermes-agent",
        defaultModelId: "A",
      }),
    ).toBe("A");
    expect(
      yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "A",
        requestedModelId: "A",
      }),
    ).toBe("A");
    expect(
      yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "A",
        requestedModelId: "B",
      }),
    ).toBe("B");
    expect(calls).toEqual(["B"]);
  }),
);
const tool = (
  hermes: Record<string, unknown>,
  data: Record<string, unknown> = {},
): AcpToolCallState => ({
  toolCallId: "call",
  kind: "other",
  status: "completed",
  title: "Tool",
  data: { meta: { hermes }, ...data },
});
describe("Hermes tools and native subagents", () => {
  it("reads JSON-string arguments and preserves the tool identity", () => {
    const call = normalizeHermesToolCall(
      tool({ toolName: "browser_exec" }, { rawInput: '{"code":"# Checking the page\\nprint(1)"}' }),
    );
    expect(call.data.rawInput).toEqual({ code: "# Checking the page\nprint(1)" });
    expect(call.data.hermesToolName).toBe("browser_exec");
    expect(call.title).toBe("Ran a browser script");
  });
  it("retains a failed tool's explanation", () => {
    const call = normalizeHermesToolCall({
      ...tool({ toolName: "skills_list" }, { rawOutput: "Permission denied" }),
      status: "failed",
      detail: "Permission denied",
    });
    expect(call.detail).toBe("Permission denied");
  });
  it("projects browser calls as named dynamic tools with browser icons", () => {
    const call = tool({ toolName: "browser_exec" }, { rawInput: { code: "# Inspect page" } });
    const base = { type: "dynamic_tool", toolName: "Tool", input: {}, title: "Tool" } as Parameters<
      typeof projectHermesToolCall
    >[1];
    expect(projectHermesToolCall(normalizeHermesToolCall(call), base)).toMatchObject({
      type: "dynamic_tool",
      toolName: "browser_exec",
      toolSurface: "browser",
      title: "Ran a browser script",
    });
  });
  it("maps delegate_task metadata to native lineage and keeps the entire result up to 20000 chars", () => {
    const result = "r".repeat(21000);
    const update = extractHermesSubagentUpdate(
      tool({
        toolName: "delegate_task",
        subagent: {
          event: "completed",
          id: "child",
          parentId: "parent",
          goal: "Check things",
          status: "completed",
          model: "zai:glm-5.3",
          summary: result,
        },
      }),
    );
    expect(update).toMatchObject({
      nativeTaskId: "child",
      childSessionId: "child",
      parentSessionId: "parent",
      prompt: "Check things",
      status: "completed",
      model: "zai:glm-5.3",
    });
    expect(update?.result?.length).toBe(20000);
  });
});
