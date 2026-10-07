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
  const bodies = {
    approval: "An agent needs your approval.",
    input: "An agent needs your input.",
    completed: "The agent run completed.",
    failed: "The agent run failed.",
  };
  return {
    app_id: "zone.pharos.t3code",
    event_id: NodeCrypto.createHash("sha256")
      .update(JSON.stringify([state.environmentId, state.threadId, state.phase, state.updatedAt]))
      .digest("hex"),
    kind,
    occurred_at: Date.parse(state.updatedAt) / 1000,
    title: "T3 Code (Sol)",
    body: bodies[kind].slice(0, 160),
    route: state.deepLink,
  };
}
