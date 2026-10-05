import type { OrchestrationV2TurnItem, ToolActivitySurface } from "@t3tools/contracts";
import type { AcpToolCallState } from "../../provider/acp/AcpRuntimeModel.ts";
import type { AcpAdapterV2SubagentUpdate } from "./AcpAdapterV2.ts";
type HermesToolKind =
  | "dynamic_tool_call"
  | "command_execution"
  | "web_search"
  | "file_change"
  | "collab_agent_tool_call";
interface HermesToolPresentation {
  readonly itemType: HermesToolKind;
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
 * Tool arguments as an object. Hermes can send a completion's arguments as the
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

const BROWSER_TITLES: ReadonlyMap<string, string> = new Map([
  ["browser_navigate", "Opened a page"],
  ["browser_click", "Clicked in the browser"],
  ["browser_type", "Typed in the browser"],
  ["browser_press", "Pressed a key in the browser"],
  ["browser_scroll", "Scrolled the page"],
  ["browser_back", "Went back a page"],
  ["browser_snapshot", "Read the page"],
  ["browser_vision", "Looked at the page"],
  ["browser_get_images", "Listed the page's images"],
  ["browser_console", "Used the browser console"],
  ["browser_exec", "Ran a browser script"],
  ["browser_dialog", "Answered a browser dialog"],
  ["browser_cdp", "Sent a browser command"],
]);

/** A browser script's first line is usually a `# what this step does` comment. */
function scriptStepLabel(code: unknown): string | undefined {
  const line = oneLine(code);
  return line?.startsWith("#") ? text(line.replace(/^#+/, "")) : line;
}

function browserDetail(toolName: string, input: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case "browser_navigate":
      return oneLine(input.url);
    case "browser_click":
      return oneLine(input.ref);
    case "browser_type":
      return oneLine(input.text);
    case "browser_press":
      return oneLine(input.key);
    case "browser_scroll":
      return oneLine(input.direction);
    case "browser_vision":
      return oneLine(input.question);
    case "browser_console":
      return oneLine(input.expression);
    case "browser_exec":
      return scriptStepLabel(input.code);
    default:
      return undefined;
  }
}

function present(
  itemType: HermesToolKind,
  title: string,
  detail: string | undefined,
  toolSurface?: ToolActivitySurface,
): HermesToolPresentation {
  return {
    itemType,
    title,
    ...(detail !== undefined ? { detail } : {}),
    ...(toolSurface !== undefined ? { toolSurface } : {}),
  };
}

/**
 * How T3 shows a Hermes tool call, from the Hermes tool name and its arguments.
 * Undefined keeps the generic ACP reading, which is already right for shell
 * commands, file reads and file edits.
 */
export function hermesToolPresentation(
  toolName: string,
  rawInput: unknown,
): HermesToolPresentation | undefined {
  const input = toolArguments(rawInput);
  if (toolName.startsWith("browser_")) {
    return present(
      "dynamic_tool_call",
      BROWSER_TITLES.get(toolName) ?? "Used the browser",
      browserDetail(toolName, input),
      "browser",
    );
  }
  switch (toolName) {
    case "execute_code":
      return present("command_execution", "Ran Python", scriptStepLabel(input.code));
    case "process": {
      const action = text(input.action) ?? "check";
      const title =
        action === "kill"
          ? "Stopped a background process"
          : action === "write" || action === "submit" || action === "close"
            ? "Sent input to a background process"
            : action === "list"
              ? "Listed background processes"
              : "Checked a background process";
      return present("command_execution", title, oneLine(input.session_id));
    }
    case "search_files": {
      const pattern = oneLine(input.pattern);
      const where = oneLine(input.path);
      return present(
        "web_search",
        input.target === "files" ? "Searched for files" : "Searched code",
        pattern !== undefined && where !== undefined
          ? clip(`${pattern} in ${where}`, DETAIL_MAX_CHARS)
          : pattern,
      );
    }
    case "web_search":
      return present("web_search", "Searched the web", oneLine(input.query));
    case "web_extract": {
      const urls = Array.isArray(input.urls) ? input.urls : [];
      const first = urls[0];
      const firstUrl = oneLine(typeof first === "string" ? first : asRecord(first)?.url);
      return present(
        "web_search",
        urls.length > 1 ? `Read ${urls.length} web pages` : "Read a web page",
        firstUrl,
      );
    }
    case "skill_view": {
      const name = oneLine(input.name);
      const file = oneLine(input.file_path);
      return present(
        "dynamic_tool_call",
        "Read a skill",
        name !== undefined && file !== undefined ? `${name}/${file}` : name,
      );
    }
    case "skills_list":
      return present("dynamic_tool_call", "Listed skills", oneLine(input.category));
    case "skill_manage": {
      const action = oneLine(input.action);
      const name = oneLine(input.name);
      return present(
        "file_change",
        "Changed a skill",
        action !== undefined && name !== undefined ? `${action} ${name}` : name,
      );
    }
    case "todo":
      return present(
        "dynamic_tool_call",
        Array.isArray(input.todos) ? "Updated the to-do list" : "Read the to-do list",
        Array.isArray(input.todos)
          ? `${input.todos.length} ${input.todos.length === 1 ? "item" : "items"}`
          : undefined,
      );
    case "memory": {
      const action = oneLine(input.action);
      const target = oneLine(input.target);
      return present(
        "dynamic_tool_call",
        "Used memory",
        action !== undefined && target !== undefined ? `${action} ${target}` : action,
      );
    }
    case "session_search":
      return present("dynamic_tool_call", "Searched past sessions", oneLine(input.query));
    case "delegate_task": {
      const tasks = Array.isArray(input.tasks) ? input.tasks : [];
      const goals = tasks.flatMap((task) => {
        const goal = oneLine(asRecord(task)?.goal);
        return goal === undefined ? [] : [goal];
      });
      return present(
        "collab_agent_tool_call",
        tasks.length > 1 ? `Started ${tasks.length} subagents` : "Started a subagent",
        goals.length > 0 ? clip(goals.join("; "), DETAIL_MAX_CHARS) : oneLine(input.goal),
      );
    }
    case "vision_analyze":
      return present("dynamic_tool_call", "Looked at an image", oneLine(input.question));
    case "image_generate":
      return present(
        "dynamic_tool_call",
        "Generated an image",
        oneLine(input.prompt ?? input.description),
      );
    case "text_to_speech":
      return present("dynamic_tool_call", "Generated speech", oneLine(input.text));
    case "cronjob": {
      const action = oneLine(input.action);
      const job = oneLine(input.job_id ?? input.id);
      return present(
        "dynamic_tool_call",
        "Managed a scheduled job",
        action !== undefined && job !== undefined ? `${action} ${job}` : action,
      );
    }
    case "send_message":
      return present("dynamic_tool_call", "Sent a message", oneLine(input.target));
    case "clarify":
      return present("dynamic_tool_call", "Asked a question", oneLine(input.question));
    default:
      return undefined;
  }
}

function hermesMeta(tool: AcpToolCallState) {
  return asRecord(asRecord(tool.data.meta)?.hermes);
}
export function normalizeHermesToolCall(tool: AcpToolCallState): AcpToolCallState {
  const name = text(hermesMeta(tool)?.toolName);
  if (name === undefined) return tool;
  const rawInput = toolArguments(tool.data.rawInput);
  const presentation = hermesToolPresentation(name, rawInput);
  return {
    ...tool,
    ...(presentation
      ? {
          title: presentation.title,
          detail:
            tool.status === "failed" ? (tool.detail ?? presentation.detail) : presentation.detail,
        }
      : {}),
    data: { ...tool.data, rawInput, hermesToolName: name },
  };
}
/** Metadata lifecycle tools are projected through upstream's native child-thread and execution-node model. */
export function extractHermesSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  const child = asRecord(hermesMeta(tool)?.subagent);
  const id = text(child?.id);
  if (!id || !["started", "progress", "completed"].includes(String(child?.event))) return undefined;
  const terminal = child?.event === "completed";
  const status = !terminal
    ? "running"
    : child?.status === "stopped"
      ? "cancelled"
      : child?.status === "failed"
        ? "failed"
        : "completed";
  const goal = text(child?.goal) ?? "Delegated task";
  return {
    nativeTaskId: id,
    childSessionId: id,
    parentSessionId: text(child?.parentId) ?? null,
    prompt: goal.slice(0, 5000),
    title: goal.split("\n")[0]!.slice(0, 120),
    model: text(child?.model) ?? null,
    status,
    result: terminal ? (text(child?.summary)?.slice(0, 20000) ?? null) : null,
  };
}
export function projectHermesToolCall(
  tool: AcpToolCallState,
  item: OrchestrationV2TurnItem,
): OrchestrationV2TurnItem {
  const name = text(tool.data.hermesToolName);
  if (name === undefined) return item;
  const presentation = hermesToolPresentation(name, tool.data.rawInput);
  // Native file and shell rows already have rich views; every other Hermes
  // tool must retain its exact name (also used by the voice-note renderer).
  if (
    (name === "terminal" || name === "read_file" || name === "write_file" || name === "patch") &&
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
