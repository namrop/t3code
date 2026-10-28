import { describe, expect, it } from "vite-plus/test";
import { ScheduledTaskId, type OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import { isTurnAuthor, t3TurnAuthor } from "./TurnAuthor.ts";

const typed = { version: 1, author: "luis", via: "t3", kind: "typed" };
const composer = {
  createdBy: "user",
  creationSource: "web",
  attachments: [],
} as const satisfies Pick<
  OrchestrationV2ConversationMessage,
  "createdBy" | "creationSource" | "attachments"
>;

describe("turn-author contract", () => {
  it.each(["t3", "discord", "runtime", "paperclip"])("accepts v1 via %s", (via) => {
    expect(isTurnAuthor({ ...typed, via })).toBe(true);
  });
  it.each([
    undefined,
    null,
    [],
    "label",
    { ...typed, version: "1" },
    { ...typed, version: 2 },
    { ...typed, author: "user" },
    { ...typed, via: "hermes" },
    { version: 1, author: "luis", via: "t3" },
    { ...typed, kind: "" },
    { ...typed, kind: "Typed" },
    { ...typed, kind: "bad-kind" },
    { ...typed, kind: "a".repeat(65) },
    { ...typed, extra: true },
  ])("treats malformed label %# as absent", (value) => {
    expect(isTurnAuthor(value)).toBe(false);
  });
  it("accepts the kind length limits without normalization", () => {
    expect(isTurnAuthor({ ...typed, author: "machine", kind: "a" })).toBe(true);
    expect(isTurnAuthor({ ...typed, kind: "a".repeat(64) })).toBe(true);
  });
  it("labels scheduled prompts as machine even when their saved creator was the user", () => {
    expect(
      t3TurnAuthor({ ...composer, scheduledTaskId: ScheduledTaskId.make("scheduled") }),
    ).toEqual({
      version: 1,
      author: "machine",
      via: "t3",
      kind: "scheduled_task",
    });
  });
  it("does not let a handoff wrapper invent knowledge about an unknown user origin", () => {
    expect(t3TurnAuthor({ ...composer, creationSource: "mcp" }, { handoff: true })).toBeUndefined();
  });
  it("marks copied composer words as machine on a restart continuation", () => {
    expect(t3TurnAuthor(composer, { replay: true })).toEqual({
      version: 1,
      author: "machine",
      via: "t3",
      kind: "continuation",
    });
  });
  it("marks a replay-only context handoff as machine", () => {
    expect(t3TurnAuthor(composer, { handoff: true, replay: true })).toEqual({
      version: 1,
      author: "machine",
      via: "t3",
      kind: "handoff",
    });
  });
});
