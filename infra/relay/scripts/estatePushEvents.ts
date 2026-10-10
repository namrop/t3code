import * as NodeCrypto from "node:crypto";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";

export interface EstatePushEvent {
  app_id: string;
  event_id: string;
  kind: "approval" | "input" | "completed" | "failed";
  occurred_at: number;
  title: string;
  body: string;
  route: string;
}

const fallbackHeadlines = {
  approval: "Approval needed",
  input: "Waiting for input",
  completed: "Agent finished",
  failed: "Agent failed",
} as const;

function cleanText(value: string | undefined): string {
  return (value ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let prefix = "";
  for (const character of value) {
    if (prefix.length + character.length > limit - 1) break;
    prefix += character;
  }
  const wordBoundary = prefix.lastIndexOf(" ");
  if (wordBoundary > 0) prefix = prefix.slice(0, wordBoundary);
  return `${prefix.trimEnd()}…`;
}

export function eventForState(
  state: AgentAwarenessState,
  previous: Pick<AgentAwarenessState, "phase"> | null,
): EstatePushEvent | null {
  if (state.phase === previous?.phase) return null;
  const kinds = {
    waiting_for_approval: "approval",
    waiting_for_input: "input",
    completed: "completed",
    failed: "failed",
  } as const;
  if (!(state.phase in kinds)) return null;
  const kind = kinds[state.phase as keyof typeof kinds];
  const project = boundedText(cleanText(state.projectTitle) || "T3 Code", 60);
  const headline = boundedText(cleanText(state.headline) || fallbackHeadlines[kind], 40);
  const prefix = `${project} · ${headline}`;
  const detail = cleanText(state.detail);
  const body = detail
    ? `${prefix} — ${boundedText(detail, Math.max(1, 160 - prefix.length - 3))}`
    : boundedText(prefix, 160);
  return {
    app_id: "zone.pharos.t3code",
    event_id: NodeCrypto.createHash("sha256")
      .update(JSON.stringify([state.environmentId, state.threadId, state.phase, state.updatedAt]))
      .digest("hex"),
    kind,
    occurred_at: Date.parse(state.updatedAt) / 1000,
    title: boundedText(cleanText(state.threadTitle) || "T3 Code", 80),
    body,
    route: state.deepLink,
  };
}
