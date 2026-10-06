import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import {
  buildOpenClawAcpSpawnInput,
  buildOpenClawModelsFromConfigOptions,
} from "../../provider/acp/OpenClawAcpSupport.ts";
import { makeOpenClawAcpAdapterFlavor } from "./OpenClawAdapterV2.ts";
import {
  normalizeOpenClawToolCall,
  projectOpenClawToolCall,
  openclawToolPresentation,
} from "./OpenClawAcp.ts";
import type { AcpToolCallState } from "../../provider/acp/AcpRuntimeModel.ts";
describe("OpenClaw ACP compatibility", () => {
  it("discovers bridge choices exactly, representing clear as the provider Default", () => {
    const models = buildOpenClawModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "kimi/k3",
        options: [
          { value: "default", name: "Default" },
          { value: "kimi/k3", name: "K3" },
        ],
      },
    ]);
    expect(models.map((model) => [model.slug, model.isDefault])).toEqual([
      ["openclaw-default", true],
      ["kimi/k3", undefined],
    ]);
  });
  it("advertises in-session model, access and native subagent support", () => {
    const flavor = makeOpenClawAcpAdapterFlavor({ settings: {} } as never);
    expect(flavor.capabilities.sessions.supportsModelSwitchInSession).toBe(true);
    expect(flavor.capabilities.sessions.supportsRuntimeModeSwitchInSession).toBe(true);
    expect(flavor.capabilities.subagents.supportsSubagents).toBe(true);
  });
  it.effect("sets exact model refs and switches back without using thinking modes", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      let currentValue = "openai/original";
      const runtime = {
        getConfigOptions: Effect.sync(() => [
          { id: "model", type: "select", category: "model", currentValue },
        ]),
        setConfigOption: (id: string, value: string) =>
          Effect.sync(() => {
            calls.push([id, value]);
            currentValue = value === "default" ? "openai/original" : value;
            return { configOptions: [] };
          }),
      } as never;
      const flavor = makeOpenClawAcpAdapterFlavor({ settings: {} } as never);
      const apply = (model: string) =>
        flavor.applyModelSelection!({
          runtime,
          startResult: {} as never,
          modelSelection: { instanceId: "openclaw" as never, model },
        });
      expect(yield* apply("openclaw-default")).toBe("openai/original");
      yield* apply("openai/original");
      yield* apply("openrouter/anthropic/other");
      yield* apply("openai/original");
      yield* apply("openrouter/anthropic/other");
      expect(yield* apply("openclaw-default")).toBe("openai/original");
      expect(calls).toEqual([
        ["model", "default"],
        ["model", "openrouter/anthropic/other"],
        ["model", "openai/original"],
        ["model", "openrouter/anthropic/other"],
        ["model", "default"],
      ]);
      expect(
        yield* flavor.applyModelSelection!({
          runtime: { getConfigOptions: Effect.succeed([]) } as never,
          startResult: {} as never,
          modelSelection: { instanceId: "openclaw" as never, model: "openai/original" },
        }),
      ).toBeUndefined();
    }),
  );
  it("keeps a labeled current model when the catalog does not include it", () => {
    expect(
      buildOpenClawModelsFromConfigOptions([
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "openai/pinned",
          options: [{ value: "google/other", name: "Other" }],
        },
      ]).map((m) => [m.slug, m.name, m.isDefault]),
    ).toEqual([
      ["google/other", "Other", undefined],
      ["openai/pinned", "openai/pinned", true],
    ]);
  });
  it.effect("sets all T3 access modes through permission_mode, not ACP thinking modes", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      let currentValue = "read-only";
      const runtime = {
        getConfigOptions: Effect.sync(() => [
          { id: "permission_mode", type: "select", currentValue },
        ]),
        setConfigOption: (id: string, value: string) =>
          Effect.sync(() => {
            calls.push([id, value]);
            currentValue = value;
            return { configOptions: [] };
          }),
      } as never;
      const flavor = makeOpenClawAcpAdapterFlavor({ settings: {} } as never);
      for (const runtimeMode of [
        "approval-required",
        "auto",
        "full-access",
        "auto-accept-edits",
      ] as const) {
        yield* flavor.applyRuntimePolicy!({
          runtime,
          policy: { runtimeMode, interactionMode: "default", cwd: "/repo" },
        });
      }
      expect(calls).toEqual([
        ["permission_mode", "guarded"],
        ["permission_mode", "workspace"],
        ["permission_mode", "full"],
        ["permission_mode", "guarded"],
      ]);
      expect(flavor.sessionModeForPolicy).toBeUndefined();
      expect(
        flavor.permissionDisposition!(
          { runtimeMode: "auto", interactionMode: "default", cwd: "/repo" },
          {} as never,
        ),
      ).toBe("ask");
    }),
  );
  it.effect("warns once per session without rejecting unsupported access modes", () => {
    const warnings: unknown[] = [];
    const logger = Logger.make(({ message, logLevel }) => {
      if (logLevel === "Warn") warnings.push(message);
    });
    return Effect.gen(function* () {
      const flavor = makeOpenClawAcpAdapterFlavor({ settings: {} } as never);
      const runtime = { getConfigOptions: Effect.succeed([]) } as never;
      for (const runtimeMode of [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ] as const) {
        yield* flavor.applyRuntimePolicy!({
          runtime,
          policy: { runtimeMode, interactionMode: "default", cwd: "/repo" },
        });
      }
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0])).toContain("permission_mode");
      expect(String(warnings[0])).toContain("T3 access modes are unavailable");
      yield* flavor.applyRuntimePolicy!({
        runtime: { getConfigOptions: Effect.succeed([]) } as never,
        policy: { runtimeMode: "approval-required", interactionMode: "default", cwd: "/repo" },
      });
      expect(warnings).toHaveLength(2);
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });
  it.each(["started", "progress", "completed"] as const)(
    "projects %s child metadata even after the spawn tool completed",
    (event) => {
      const flavor = makeOpenClawAcpAdapterFlavor({ settings: {} } as never);
      expect(
        flavor.extractSubagentUpdate!({
          toolCallId: "spawn",
          kind: "other",
          status: "completed",
          title: "sessions_spawn",
          data: {
            meta: {
              openclaw: {
                subagent: {
                  id: "agent:main:subagent:child",
                  parentId: "agent:main:subagent:parent",
                  event,
                  goal: "Check things",
                  model: "openai/sol",
                  status: "stopped",
                  summary: "Done",
                },
              },
            },
          },
        }),
      ).toMatchObject({
        nativeTaskId: "agent:main:subagent:child",
        childSessionId: "agent:main:subagent:child",
        parentSessionId: "agent:main:subagent:parent",
        prompt: "Check things",
        title: "Check things",
        model: "openai/sol",
        status: event === "completed" ? "cancelled" : "running",
        result: event === "completed" ? "Done" : null,
      });
    },
  );
  it("rejects unrelated child metadata and maps terminal outcomes with bounded summaries", () => {
    const extract = makeOpenClawAcpAdapterFlavor({ settings: {} } as never).extractSubagentUpdate!;
    expect(extract(call("sessions_spawn"))).toBeUndefined();
    for (const [status, expected] of [
      ["completed", "completed"],
      ["failed", "failed"],
    ]) {
      const result = extract({
        ...call("sessions_spawn"),
        data: {
          meta: {
            openclaw: {
              subagent: {
                id: "child",
                event: "completed",
                parentId: null,
                model: null,
                goal: "x",
                status,
                summary: "r".repeat(21000),
              },
            },
          },
        },
      });
      expect(result?.status).toBe(expected);
      expect(result?.result?.length).toBe(20000);
      expect(result?.parentSessionId).toBeNull();
    }
  });
  it("spawns the configured bridge without banners or notes", () => {
    expect(
      buildOpenClawAcpSpawnInput({ binaryPath: "/bin/openclaw" }, "/repo", {
        PATH: "/bin",
        OPENCLAW_HIDE_BANNER: "0",
      }),
    ).toEqual({
      command: "/bin/openclaw",
      args: ["acp"],
      cwd: "/repo",
      extendEnv: false,
      env: { PATH: "/bin", OPENCLAW_HIDE_BANNER: "1", OPENCLAW_SUPPRESS_NOTES: "1" },
    });
  });
  it("omits MCP and keys sessions to the configured agent and T3 thread", () => {
    const flavor = makeOpenClawAcpAdapterFlavor({ settings: { agentId: "coding" } } as never);
    expect(flavor.omitMcpServers).toBe(true);
    expect(flavor.capabilities.tools.supportsMcpTools).toBe(false);
    expect(flavor.sessionRequestMeta?.(ThreadId.make("thread-1"))).toEqual({
      sessionKey: "agent:coding:t3:thread-1",
    });
    expect(flavor.sessionRequestMeta?.(null)).toBeUndefined();
  });
  it("discovers grouped model-category options without duplicates", () => {
    expect(
      buildOpenClawModelsFromConfigOptions([
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "openai/sol",
          options: [
            {
              groupId: "openai",
              name: "OpenAI",
              options: [
                { value: "openai/sol", name: "Sol" },
                { value: "openai/sol", name: "Duplicate" },
              ],
            },
          ],
        },
      ]).map((m) => [m.slug, m.isDefault]),
    ).toEqual([["openai/sol", true]]);
    expect(buildOpenClawModelsFromConfigOptions([])).toEqual([]);
  });
});
const call = (name: string, rawInput: unknown = {}): AcpToolCallState => ({
  toolCallId: "call",
  kind: "other",
  status: "completed",
  title: "Tool",
  data: { meta: { openclaw: { toolName: name } }, rawInput, rawOutput: "result" },
});
describe("OpenClaw tool rows", () => {
  it.each([
    ["exec", { command: "pwd" }, "Ran a command", "pwd"],
    [
      "process",
      { action: "poll", sessionId: "process-1" },
      "Checked a background process",
      "process-1",
    ],
    ["read", { path: "/repo/a" }, "Read a file", "/repo/a"],
    ["write", { file_path: "/repo/a" }, "Wrote a file", "/repo/a"],
    ["edit", { path: "/repo/a" }, "Edited a file", "/repo/a"],
    ["apply_patch", { input: "*** Begin Patch" }, "Applied a patch", "*** Begin Patch"],
    ["web_search", { query: "T3" }, "Searched the web", "T3"],
    ["web_fetch", { url: "https://example.com" }, "Read a web page", "https://example.com"],
    [
      "browser",
      { action: "open", url: "https://example.com" },
      "Opened a page",
      "https://example.com",
    ],
    ["message", { action: "send", target: "room" }, "Sent a message", "room"],
    ["cron", { action: "list" }, "Managed a scheduled job", "list"],
    ["automations", { action: "list" }, "Managed a scheduled job", "list"],
    ["sessions_spawn", { task: "Check it" }, "Started a subagent", "Check it"],
    ["sessions_send", { sessionKey: "child" }, "Sent to a session", "child"],
    ["sessions_list", { search: "T3" }, "Listed sessions", "T3"],
    ["sessions_history", { sessionKey: "child" }, "Read session history", "child"],
    ["sessions", { action: "list" }, "Managed sessions", "list"],
    ["session_status", { sessionKey: "child" }, "Checked session status", "child"],
    ["memory_search", { query: "T3" }, "Searched memory", "T3"],
    ["memory_get", { path: "MEMORY.md" }, "Read memory", "MEMORY.md"],
    ["image", { prompt: "Describe" }, "Looked at an image", "Describe"],
    ["view_image", { prompt: "Describe" }, "Looked at an image", "Describe"],
    ["image_generate", { prompt: "Draw" }, "Generated an image", "Draw"],
    ["tts", { text: "Hello" }, "Generated speech", "Hello"],
    ["nodes", { action: "status" }, "Used a device", "status"],
  ])("presents %s with its real arguments", (name, input, title, detail) => {
    expect(openclawToolPresentation(name as string, input)).toMatchObject({ title, detail });
  });
  it("preserves identity and complete output, including transcripts and unknown tools", () => {
    for (const name of ["browser", "voice_note_transcript", "future_tool"]) {
      const tool = normalizeOpenClawToolCall(call(name, '{"action":"snapshot"}'));
      expect(tool.data.rawInput).toEqual({ action: "snapshot" });
      expect(projectOpenClawToolCall(tool, { type: "dynamic_tool" } as never)).toMatchObject({
        type: "dynamic_tool",
        toolName: name,
        input: { action: "snapshot" },
        output: "result",
      });
    }
  });
  it("keeps rich native command/file rows and failed explanations", () => {
    const tool = normalizeOpenClawToolCall({
      ...call("exec", { command: "false" }),
      status: "failed",
      detail: "Permission denied",
    });
    expect(tool.detail).toBe("Permission denied");
    const base = { type: "command", title: "Ran a command" } as never;
    expect(projectOpenClawToolCall(tool, base)).toBe(base);
    expect(normalizeOpenClawToolCall({ ...call("exec"), data: {} }).title).toBe("Tool");
  });
});
