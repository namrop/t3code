import {
  RuntimeTaskId,
  type ProviderRuntimeTaskCompletedEvent,
  type ProviderRuntimeTaskProgressEvent,
  type ProviderRuntimeTaskStartedEvent,
  type ToolActivitySurface,
  type ToolLifecycleItemType,
  type TurnId,
} from "@t3tools/contracts";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

/**
 * What Hermes states about a tool call in the ACP `_meta.hermes` field (Hermes
 * fork ADR, 2026-10-01): the Hermes tool's name and, for a child that
 * `delegate_task` started, the child's lifecycle record. ACP tool kinds are too
 * coarse to tell a browser click from a shell command, so rows follow the name.
 */
export interface HermesToolMeta {
  readonly toolName: string;
  readonly subagent?: HermesSubagentRecord;
}

export interface HermesSubagentRecord {
  readonly event: "started" | "progress" | "completed";
  readonly id: string;
  readonly goal: string;
  readonly status?: string;
  readonly parentId?: string;
  readonly parentToolCallId?: string;
  readonly model?: string;
  readonly role?: string;
  readonly lastToolName?: string;
  readonly taskIndex?: number;
  readonly summary?: string;
}

export interface HermesToolPresentation {
  readonly itemType: ToolLifecycleItemType;
  readonly title: string;
  readonly detail?: string;
  readonly toolSurface?: ToolActivitySurface;
}

type HermesTaskEvent =
  | Pick<ProviderRuntimeTaskStartedEvent, "type" | "payload" | "turnId">
  | Pick<ProviderRuntimeTaskProgressEvent, "type" | "payload" | "turnId">
  | Pick<ProviderRuntimeTaskCompletedEvent, "type" | "payload" | "turnId">;

const DETAIL_MAX_CHARS = 200;
const TASK_TITLE_MAX_CHARS = 120;
const TASK_TEXT_MAX_CHARS = 5_000;

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

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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

/** Reads `_meta.hermes` off the session/update notification that carried a tool call. */
export function readHermesToolMeta(rawPayload: unknown): HermesToolMeta | undefined {
  const update = asRecord(asRecord(rawPayload)?.update);
  const hermes = asRecord(asRecord(update?._meta)?.hermes);
  const toolName = text(hermes?.toolName);
  if (toolName === undefined) return undefined;
  const child = asRecord(hermes?.subagent);
  const event = child?.event;
  const id = text(child?.id);
  if (
    child === undefined ||
    id === undefined ||
    (event !== "started" && event !== "progress" && event !== "completed")
  ) {
    return { toolName };
  }
  const optional = {
    status: text(child.status),
    parentId: text(child.parentId),
    parentToolCallId: text(child.parentToolCallId),
    model: text(child.model),
    role: text(child.role),
    lastToolName: text(child.lastToolName),
    taskIndex: count(child.taskIndex),
    summary: text(child.summary),
  };
  return {
    toolName,
    subagent: {
      event,
      id,
      goal: text(child.goal) ?? "Delegated task",
      ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
    },
  };
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
  itemType: ToolLifecycleItemType,
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

/**
 * Applies a Hermes tool's identity to the generic ACP state: the presentation
 * replaces the generic title and detail, and `data.hermesToolName` carries the
 * name to clients (the activity projection keeps it).
 */
export function applyHermesToolIdentity(
  toolCall: AcpToolCallState,
  toolName: string,
): {
  readonly toolCall: AcpToolCallState;
  readonly itemType?: ToolLifecycleItemType;
  readonly toolSurface?: ToolActivitySurface;
} {
  const presentation = hermesToolPresentation(toolName, toolCall.data.rawInput);
  const data = { ...toolCall.data, hermesToolName: toolName };
  if (presentation === undefined) {
    return { toolCall: { ...toolCall, data } };
  }
  const {
    detail: genericDetail,
    detailIsOutput,
    titleIsPlaceholder: _placeholder,
    ...rest
  } = toolCall;
  // Without arguments to read, the generic detail stays, unless it is the
  // output of a call that did not fail (a failure's output says why).
  const detail =
    presentation.detail ??
    (detailIsOutput && toolCall.status !== "failed" ? undefined : genericDetail);
  return {
    toolCall: {
      ...rest,
      title: presentation.title,
      ...(detail !== undefined ? { detail } : {}),
      data,
    },
    itemType: presentation.itemType,
    ...(presentation.toolSurface !== undefined ? { toolSurface: presentation.toolSurface } : {}),
  };
}

const COMPLETED_STATUS: ReadonlyMap<string, "completed" | "failed" | "stopped"> = new Map([
  ["completed", "completed"],
  ["failed", "failed"],
  ["stopped", "stopped"],
]);

/** Hermes prefixes child progress lines with a fork glyph; the Agents panel has its own chrome. */
function progressSummary(value: string | undefined): string | undefined {
  return value === undefined ? undefined : text(value.replace(/^🔀\s*/u, ""));
}

/**
 * The T3 task event for one delegated child's lifecycle update, which is what
 * fills the Agents panel and the "Kicked off N subagents" row.
 */
export function hermesSubagentTaskEvent(
  child: HermesSubagentRecord,
  turnId: TurnId | undefined,
): HermesTaskEvent {
  const goal = clip(child.goal, TASK_TEXT_MAX_CHARS);
  const linkage = {
    taskId: RuntimeTaskId.make(child.id),
    taskType: "subagent",
    title: clip(oneLine(child.goal) ?? child.goal, TASK_TITLE_MAX_CHARS),
    ...(child.model !== undefined ? { model: child.model } : {}),
    // "leaf" is Hermes's default role and says nothing to the reader.
    ...(child.role !== undefined && child.role !== "leaf" ? { role: child.role } : {}),
    ...(child.parentToolCallId !== undefined ? { toolUseId: child.parentToolCallId } : {}),
    ...(child.parentId !== undefined ? { agentId: child.parentId } : {}),
    ...(child.taskIndex !== undefined ? { agentIndex: child.taskIndex } : {}),
  };
  const attribution = turnId !== undefined ? { turnId } : {};
  const summary = progressSummary(child.summary);
  switch (child.event) {
    case "started":
      return { type: "task.started", payload: { ...linkage, description: goal }, ...attribution };
    case "progress":
      return {
        type: "task.progress",
        payload: {
          ...linkage,
          description: goal,
          status: "running",
          ...(summary !== undefined ? { summary: clip(summary, TASK_TEXT_MAX_CHARS) } : {}),
          ...(child.lastToolName !== undefined ? { lastToolName: child.lastToolName } : {}),
        },
        ...attribution,
      };
    case "completed":
      return {
        type: "task.completed",
        payload: {
          ...linkage,
          status: COMPLETED_STATUS.get(child.status ?? "completed") ?? "failed",
          ...(summary !== undefined ? { summary: clip(summary, TASK_TEXT_MAX_CHARS) } : {}),
        },
        ...attribution,
      };
  }
}
