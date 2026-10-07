import { describe, expect, it } from "vite-plus/test";
import { eventForState } from "./estatePushEvents.ts";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";

const state = (phase: AgentAwarenessState["phase"], updatedAt = "2026-10-07T00:00:00Z") =>
  ({
    environmentId: "env",
    threadId: "thread",
    phase,
    updatedAt,
    projectTitle: "PRIVATE PROJECT",
    threadTitle: "PRIVATE THREAD",
    headline: "PRIVATE HEADLINE",
    detail: "SECRET exception",
    modelTitle: "model",
    deepLink: "/threads/env/thread",
  }) as AgentAwarenessState;

describe("estate push T3 event adapter", () => {
  it.each(["waiting_for_approval", "waiting_for_input", "completed", "failed"] as const)(
    "redacts %s without losing its thread route",
    (phase) => {
      const event = eventForState(state(phase), null);
      expect(event?.route).toBe("/threads/env/thread");
      expect(JSON.stringify(event)).not.toContain("PRIVATE");
      expect(JSON.stringify(event)).not.toContain("SECRET");
      expect(event!.body.length).toBeLessThanOrEqual(160);
    },
  );
  it("uses the fixed failure message", () => {
    expect(eventForState(state("failed"), null)?.body).toBe("The agent run failed.");
  });
  it.each(["starting", "running", "stale"] as const)("does not alert on %s", (phase) => {
    expect(eventForState(state(phase), null)).toBeNull();
  });
  it("does not alert again when only shell text changes", () => {
    expect(
      eventForState(state("completed", "2026-10-07T01:00:00Z"), state("completed")),
    ).toBeNull();
  });
  it("reuses a stable identifier for the same transition", () => {
    expect(eventForState(state("completed"), null)?.event_id).toBe(
      eventForState(state("completed"), null)?.event_id,
    );
    expect(eventForState(state("completed"), null)?.event_id).not.toBe(
      eventForState(state("failed"), null)?.event_id,
    );
  });
});
