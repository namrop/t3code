import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
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
