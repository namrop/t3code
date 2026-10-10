import { describe, expect, it } from "vite-plus/test";
import { eventForState } from "./estatePushEvents.ts";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";

const state = (
  phase: AgentAwarenessState["phase"],
  updatedAt = "2026-10-07T00:00:00Z",
  overrides: Partial<AgentAwarenessState> = {},
) =>
  ({
    environmentId: "env",
    threadId: "thread",
    phase,
    updatedAt,
    projectTitle: "Example project",
    threadTitle: "Release notes thread",
    headline: "Agent failed",
    detail: "The agent run failed.",
    modelTitle: "model",
    deepLink: "/threads/env/thread",
    ...overrides,
  }) as AgentAwarenessState;

describe("estate push T3 event adapter", () => {
  it.each([
    ["waiting_for_approval", "Approval needed", undefined],
    ["waiting_for_input", "Waiting for input", undefined],
    ["completed", "Agent finished", "Review the completed task."],
    ["failed", "Agent failed", "The agent run failed."],
  ] as const)("includes source context for %s", (phase, headline, detail) => {
    const event = eventForState(state(phase, "2026-10-07T00:00:00Z", { headline, detail }), null);
    expect(event?.route).toBe("/threads/env/thread");
    expect(event?.title).toBe("Release notes thread");
    expect(event?.body).toBe(
      `Example project · ${headline}${detail === undefined ? "" : ` — ${detail}`}`,
    );
    expect(event!.body.length).toBeLessThanOrEqual(160);
  });
  it("normalizes labels and truncates long titles and details with an ellipsis", () => {
    const event = eventForState(
      state("completed", "2026-10-07T00:00:00Z", {
        threadTitle: "Release\u0000 notes\n" + "planning update ".repeat(8),
        projectTitle: "Example\t\n project",
        headline: "Agent\r\nfinished",
        detail: "Review the completed task. ".repeat(12),
      }),
      null,
    );
    expect(event?.title.startsWith("Release notes planning update")).toBe(true);
    expect(event!.title.length).toBeLessThanOrEqual(80);
    expect(event!.title.endsWith("…")).toBe(true);
    expect(("Release notes " + "planning update ".repeat(8)).split(/\s+/)).toContain(
      event!.title.slice(0, -1).split(" ").at(-1),
    );
    expect(event?.body).toContain("Example project · Agent finished — Review");
    expect(event!.body.length).toBeLessThanOrEqual(160);
    expect(event!.body.endsWith("…")).toBe(true);
    expect(event!.title).not.toMatch(/\p{Cc}/u);
    expect(event!.body).not.toMatch(/\p{Cc}/u);
  });
  it("falls back cleanly when display labels are blank", () => {
    const event = eventForState(
      state("failed", "2026-10-07T00:00:00Z", {
        threadTitle: " \t\n",
        projectTitle: "\u0000",
        headline: " ",
        detail: " \r\n",
      }),
      null,
    );
    expect(event?.title).toBe("T3 Code");
    expect(event?.body).toBe("T3 Code · Agent failed");
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
