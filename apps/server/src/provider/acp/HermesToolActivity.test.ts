import { describe, expect, it } from "vite-plus/test";
import { TurnId } from "@t3tools/contracts";

import type * as EffectAcpSchema from "effect-acp/schema";

import { mergeToolCallState, parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";
import {
  applyHermesToolIdentity,
  hermesSubagentTaskEvent,
  hermesToolPresentation,
  readHermesToolMeta,
} from "./HermesToolActivity.ts";

const turnId = TurnId.make("turn-1");

function toolCallOf(notification: EffectAcpSchema.SessionNotification) {
  const [event] = parseSessionUpdateEvent(notification).events;
  if (event?._tag !== "ToolCallUpdated") throw new Error("expected a tool call update");
  return event;
}

// Shapes as Hermes sends them (Hermes fork, branch luis/acp-tool-identity-20261001).
const sessionSearchStart = {
  sessionId: "s-1",
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "tc-search",
    title: "session search: voice",
    kind: "other",
    status: "pending",
    rawInput: { query: "voice" },
    content: [
      { type: "content", content: { type: "text", text: "Searching past sessions for: voice" } },
    ],
  },
} satisfies EffectAcpSchema.SessionNotification;

const sessionSearchDoneWithoutTitle = {
  sessionId: "s-1",
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-search",
    kind: "other",
    status: "completed",
    content: [
      {
        type: "content",
        content: { type: "text", text: "Session search results for `voice` - **Voice notes**" },
      },
    ],
  },
} satisfies EffectAcpSchema.SessionNotification;

describe("ACP tool calls that finish without a title", () => {
  it("keep the title and detail they started with instead of 'Tool' and the output", () => {
    const start = toolCallOf(sessionSearchStart).toolCall;
    const done = toolCallOf(sessionSearchDoneWithoutTitle).toolCall;
    // Read alone, the completion says nothing about itself.
    expect(done.title).toBe("Tool");

    const merged = mergeToolCallState(start, done);
    expect(merged.title).toBe("session search: voice");
    // The start had nothing to add under its title, and the output does not fill the gap.
    expect(merged.detail).toBeUndefined();
    // The output itself is still kept for the expanded row.
    expect(merged.data.content).toEqual(done.data.content);
    expect(merged.status).toBe("completed");
  });
});

describe("Hermes tool identity", () => {
  const browserClick = {
    sessionId: "s-1",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tc-click",
      title: "browser_click",
      kind: "execute",
      status: "pending",
      rawInput: { ref: "@e5" },
      _meta: { hermes: { toolName: "browser_click" } },
    },
  } satisfies EffectAcpSchema.SessionNotification;

  it("reads the Hermes tool name from the update's _meta", () => {
    expect(readHermesToolMeta(toolCallOf(browserClick).rawPayload)).toEqual({
      toolName: "browser_click",
    });
    expect(readHermesToolMeta(toolCallOf(sessionSearchStart).rawPayload)).toBeUndefined();
  });

  it("shows a browser click as a browser step, not a terminal command", () => {
    const event = toolCallOf(browserClick);
    const identified = applyHermesToolIdentity(event.toolCall, "browser_click");
    expect(identified.itemType).toBe("dynamic_tool_call");
    expect(identified.toolSurface).toBe("browser");
    expect(identified.toolCall.title).toBe("Clicked in the browser");
    expect(identified.toolCall.detail).toBe("@e5");
    expect(identified.toolCall.data.hermesToolName).toBe("browser_click");
  });

  it("labels each Hermes tool by what it does", () => {
    expect(
      hermesToolPresentation("browser_exec", {
        code: "# Opening a few pages to test the browser\nnew_tab('https://example.com')",
      }),
    ).toEqual({
      itemType: "dynamic_tool_call",
      title: "Ran a browser script",
      detail: "Opening a few pages to test the browser",
      toolSurface: "browser",
    });
    expect(hermesToolPresentation("search_files", { pattern: "Worked for", path: "apps" })).toEqual(
      { itemType: "web_search", title: "Searched code", detail: "Worked for in apps" },
    );
    expect(hermesToolPresentation("search_files", { pattern: "*.md", target: "files" })).toEqual({
      itemType: "web_search",
      title: "Searched for files",
      detail: "*.md",
    });
    expect(hermesToolPresentation("web_search", { query: "T3 Code" })).toEqual({
      itemType: "web_search",
      title: "Searched the web",
      detail: "T3 Code",
    });
    expect(hermesToolPresentation("skill_view", { name: "atrium-navigation" })).toEqual({
      itemType: "dynamic_tool_call",
      title: "Read a skill",
      detail: "atrium-navigation",
    });
    expect(
      hermesToolPresentation("delegate_task", {
        tasks: [{ goal: "Fix the icons" }, { goal: "x" }],
      }),
    ).toMatchObject({ itemType: "collab_agent_tool_call", title: "Started 2 subagents" });
    // Shell commands, file reads and edits keep T3's generic reading.
    expect(hermesToolPresentation("terminal", { command: "date" })).toBeUndefined();
    expect(hermesToolPresentation("read_file", { path: "a.ts" })).toBeUndefined();
  });

  it("reads arguments that arrive as the model's JSON string", () => {
    // A completion's string arguments replace the start's object when merged.
    expect(
      hermesToolPresentation(
        "search_files",
        '{"pattern": "pineapple", "target": "files", "path": "/tmp"}',
      ),
    ).toEqual({ itemType: "web_search", title: "Searched for files", detail: "pineapple in /tmp" });
    expect(
      hermesToolPresentation("delegate_task", '{"tasks": [{"goal": "a"}, {"goal": "b"}]}'),
    ).toMatchObject({ title: "Started 2 subagents" });
    expect(hermesToolPresentation("web_search", "not json")).toMatchObject({
      title: "Searched the web",
    });
  });

  it("keeps the start's detail when a completion has nothing to add", () => {
    const start = toolCallOf(sessionSearchStart).toolCall;
    const done = toolCallOf(sessionSearchDoneWithoutTitle).toolCall;
    const merged = mergeToolCallState(
      { ...start, detail: "voice" },
      { ...done, data: { ...done.data, rawInput: "not json" } },
    );
    expect(applyHermesToolIdentity(merged, "session_search").toolCall.detail).toBe("voice");
  });

  it("shows why an announced call failed", () => {
    const start = {
      toolCallId: "t-1",
      title: "Long command",
      status: "inProgress",
      data: {},
    } as const;
    const failed = {
      toolCallId: "t-1",
      status: "failed",
      detail: "Cancelled.",
      detailIsOutput: true,
      data: {},
    } as const;
    const merged = mergeToolCallState(start, failed);
    expect(merged.detail).toBe("Cancelled.");
    // A Hermes tool without an argument-based label keeps the failure text too.
    expect(applyHermesToolIdentity(merged, "fact_store").toolCall.detail).toBe("Cancelled.");
    // A finished call that did not fail still keeps what it was announced as.
    expect(mergeToolCallState(start, { ...failed, status: "completed" }).detail).toBeUndefined();
  });

  it("still names tools it has no special label for", () => {
    const event = toolCallOf(sessionSearchStart);
    const identified = applyHermesToolIdentity(event.toolCall, "fact_store");
    expect(identified.itemType).toBeUndefined();
    expect(identified.toolCall.title).toBe(event.toolCall.title);
    expect(identified.toolCall.data.hermesToolName).toBe("fact_store");
  });
});

describe("Hermes subagents", () => {
  const childUpdate = (subagent: Record<string, unknown>, sessionUpdate = "tool_call_update") =>
    toolCallOf({
      sessionId: "s-1",
      update: {
        sessionUpdate,
        toolCallId: "tc-child",
        title: "Inspect the adapter",
        kind: "other",
        status: subagent.event === "completed" ? "completed" : "in_progress",
        _meta: { hermes: { toolName: "delegate_task", subagent } },
      },
    } as EffectAcpSchema.SessionNotification);

  const identity = {
    id: "child-1",
    goal: "Inspect the adapter",
    model: "glm-5.3",
    role: "leaf",
    parentToolCallId: "tc-delegate",
    taskIndex: 0,
  };

  it("turns a child's lifecycle into task events for the Agents panel", () => {
    const started = readHermesToolMeta(
      childUpdate({ event: "started", status: "running", ...identity }, "tool_call").rawPayload,
    )?.subagent;
    expect(started).toBeDefined();
    expect(hermesSubagentTaskEvent(started!, turnId)).toEqual({
      type: "task.started",
      turnId,
      payload: {
        taskId: "child-1",
        taskType: "subagent",
        title: "Inspect the adapter",
        description: "Inspect the adapter",
        model: "glm-5.3",
        toolUseId: "tc-delegate",
        agentIndex: 0,
      },
    });

    const progress = readHermesToolMeta(
      childUpdate({
        event: "progress",
        status: "running",
        summary: "🔀 read_file HermesAcpSupport.ts",
        lastToolName: "read_file",
        ...identity,
      }).rawPayload,
    )?.subagent;
    expect(hermesSubagentTaskEvent(progress!, turnId)).toMatchObject({
      type: "task.progress",
      payload: {
        taskId: "child-1",
        status: "running",
        summary: "read_file HermesAcpSupport.ts",
        lastToolName: "read_file",
      },
    });

    const failed = readHermesToolMeta(
      childUpdate({
        event: "completed",
        status: "failed",
        summary: "Timed out",
        ...identity,
      }).rawPayload,
    )?.subagent;
    expect(hermesSubagentTaskEvent(failed!, undefined)).toEqual({
      type: "task.completed",
      payload: expect.objectContaining({
        taskId: "child-1",
        status: "failed",
        summary: "Timed out",
      }),
    });
  });

  it("passes a finished child's whole reply on, past the progress-text limit", () => {
    const reply = `First line.\n${"z".repeat(8_000)}`;
    const done = readHermesToolMeta(
      childUpdate({ event: "completed", status: "completed", summary: reply, ...identity })
        .rawPayload,
    )?.subagent;
    expect(hermesSubagentTaskEvent(done!, undefined).payload).toMatchObject({ summary: reply });
  });

  it("keeps a nested child under the child that started it", () => {
    const nested = readHermesToolMeta(
      childUpdate({ event: "started", id: "child-2", goal: "Look deeper", parentId: "child-1" })
        .rawPayload,
    )?.subagent;
    expect(hermesSubagentTaskEvent(nested!, turnId).payload).toMatchObject({
      taskId: "child-2",
      agentId: "child-1",
    });
  });
});
