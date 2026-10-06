import type { OrchestrationV2TurnItem, ToolActivitySurface } from "@t3tools/contracts";
import type { AcpToolCallState } from "../../provider/acp/AcpRuntimeModel.ts";
import type { AcpAdapterV2SubagentUpdate } from "./AcpAdapterV2.ts";
type OpenClawToolKind =
  | "dynamic_tool_call"
  | "command_execution"
  | "web_search"
  | "file_change"
  | "collab_agent_tool_call";
interface OpenClawToolPresentation {
  readonly itemType: OpenClawToolKind;
  readonly title: string;
  readonly detail?: string;
  readonly toolSurface?: ToolActivitySurface;
}
const DETAIL_MAX_CHARS = 200;
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Tool arguments as an object. OpenClaw can send a completion's arguments as the
 * model's JSON string; merged over the start, that string replaces the object
 * the start carried.
 */
function toolArguments(rawInput: unknown): Record<string, unknown> {
  if (typeof rawInput === "string") {
    try {
      return asRecord(JSON.parse(rawInput)) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(rawInput) ?? {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** One line for a row: the first non-empty line, clipped. */
function oneLine(value: unknown): string | undefined {
  const line = text(value)
    ?.split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line === undefined ? undefined : clip(line, DETAIL_MAX_CHARS);
}

function present(
  title: string,
  detail: unknown,
  toolSurface?: ToolActivitySurface,
): OpenClawToolPresentation {
  const line = oneLine(detail);
  return {
    itemType: "dynamic_tool_call",
    title,
    ...(line === undefined ? {} : { detail: line }),
    ...(toolSurface ? { toolSurface } : {}),
  };
}

/** Real gateway names and arguments; aliases cover older OpenClaw releases. */
export function openclawToolPresentation(
  toolName: string,
  rawInput: unknown,
): OpenClawToolPresentation | undefined {
  const input = toolArguments(rawInput);
  switch (toolName) {
    case "exec":
      return present("Ran a command", input.command);
    case "process":
      return present(
        input.action === "kill"
          ? "Stopped a background process"
          : input.action === "write" || input.action === "submit"
            ? "Sent input to a background process"
            : input.action === "list"
              ? "Listed background processes"
              : "Checked a background process",
        input.sessionId,
      );
    case "read":
      return present("Read a file", input.path ?? input.file_path);
    case "write":
      return present("Wrote a file", input.path ?? input.file_path);
    case "edit":
      return present("Edited a file", input.path ?? input.file_path);
    case "apply_patch":
      return present("Applied a patch", input.input);
    case "web_search":
      return present("Searched the web", input.query);
    case "web_fetch":
      return present("Read a web page", input.url);
    case "browser": {
      const titles: Record<string, string> = {
        open: "Opened a page",
        navigate: "Opened a page",
        snapshot: "Read the page",
        screenshot: "Looked at the page",
        act: "Used the browser",
        tabs: "Listed browser tabs",
        status: "Checked the browser",
      };
      return present(
        titles[String(input.action)] ?? "Used the browser",
        input.url ?? input.targetUrl ?? input.action,
        "browser",
      );
    }
    case "message":
      return present(
        input.action === "send" ? "Sent a message" : "Used messaging",
        input.target ?? input.action,
      );
    case "cron":
    case "automations":
      return present("Managed a scheduled job", input.action);
    case "sessions_spawn":
      return present("Started a subagent", input.task);
    case "sessions_send":
      return present("Sent to a session", input.sessionKey ?? input.label);
    case "sessions_list":
      return present("Listed sessions", input.search ?? input.agentId);
    case "sessions_history":
      return present("Read session history", input.sessionKey);
    case "sessions_yield":
      return present("Yielded to a session", input.message);
    case "sessions":
      return present("Managed sessions", input.action);
    case "session_status":
      return present("Checked session status", input.sessionKey);
    case "agents_list":
      return present("Listed agents", input.agentId);
    case "agents_wait":
      return present(
        "Waited for agents",
        Array.isArray(input.ids) ? input.ids.join(", ") : undefined,
      );
    case "subagents":
      return present("Managed subagents", input.action);
    case "memory_search":
      return present("Searched memory", input.query);
    case "memory_get":
      return present("Read memory", input.path);
    case "image":
    case "view_image":
      return present("Looked at an image", input.prompt ?? input.image);
    case "image_generate":
      return present("Generated an image", input.prompt);
    case "video_generate":
      return present("Generated a video", input.prompt);
    case "tts":
      return present("Generated speech", input.text);
    case "nodes":
      return present("Used a device", input.action);
    case "pdf":
      return present("Read a PDF", input.prompt ?? input.pdf);
    case "voice_note_transcript":
      return present("Voice note transcript", undefined);
    default:
      return undefined;
  }
}
function openclawMeta(tool: AcpToolCallState) {
  return asRecord(asRecord(tool.data.meta)?.openclaw);
}
export function normalizeOpenClawToolCall(tool: AcpToolCallState): AcpToolCallState {
  const name = text(openclawMeta(tool)?.toolName);
  if (name === undefined) return tool;
  const rawInput = toolArguments(tool.data.rawInput);
  const presentation = openclawToolPresentation(name, rawInput);
  return {
    ...tool,
    ...(presentation
      ? {
          title: presentation.title,
          detail:
            tool.status === "failed" ? (tool.detail ?? presentation.detail) : presentation.detail,
        }
      : {}),
    data: { ...tool.data, rawInput, openclawToolName: name },
  };
}
/** Spawn tool settlement is separate from the child's lifecycle. */
export function extractOpenClawSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  const child = asRecord(openclawMeta(tool)?.subagent);
  const id = text(child?.id);
  if (!id || !["started", "progress", "completed"].includes(String(child?.event))) return undefined;
  const terminal = child?.event === "completed";
  const goal = text(child?.goal) ?? "Delegated task";
  return {
    nativeTaskId: id,
    childSessionId: id,
    parentSessionId: text(child?.parentId) ?? null,
    prompt: goal.slice(0, 5000),
    title: goal.split("\n")[0]!.slice(0, 120),
    model: text(child?.model) ?? null,
    status: !terminal
      ? "running"
      : child?.status === "stopped"
        ? "cancelled"
        : child?.status === "failed"
          ? "failed"
          : "completed",
    result: terminal ? (text(child?.summary)?.slice(0, 20000) ?? null) : null,
  };
}

export function projectOpenClawToolCall(
  tool: AcpToolCallState,
  item: OrchestrationV2TurnItem,
): OrchestrationV2TurnItem {
  const name = text(tool.data.openclawToolName);
  if (name === undefined) return item;
  const presentation = openclawToolPresentation(name, tool.data.rawInput);
  // Native file and shell rows already have rich views; every other OpenClaw
  // tool must retain its exact name (also used by the voice-note renderer).
  if (
    (name === "exec" ||
      name === "read" ||
      name === "write" ||
      name === "edit" ||
      name === "apply_patch") &&
    item.type !== "dynamic_tool"
  )
    return item;
  return {
    ...item,
    providerThreadId: item.providerThreadId ?? null,
    providerTurnId: item.providerTurnId ?? null,
    nativeItemRef: item.nativeItemRef ?? null,
    type: "dynamic_tool",
    toolName: name,
    title: presentation?.title ?? tool.title ?? name,
    input: tool.data.rawInput ?? {},
    ...(tool.data.rawOutput === undefined ? {} : { output: tool.data.rawOutput }),
    ...(presentation?.toolSurface ? { toolSurface: presentation.toolSurface } : {}),
  };
}
