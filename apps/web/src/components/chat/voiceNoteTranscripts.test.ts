import { describe, expect, it } from "vite-plus/test";
import { RunId } from "@t3tools/contracts";
import { voiceNoteTranscriptsByRun } from "./voiceNoteTranscripts";

const runId = RunId.make("voice-run");
const transcript = "This is the complete recorded sentence. ".repeat(20);
const entry = (status: "completed" | "inProgress", toolName = "voice_note_transcript") => ({
  kind: "work" as const,
  entry: {
    structuredPayload: {
      type: "dynamic_tool" as const,
      runId,
      toolName,
      status,
      output: { content: [{ type: "text", text: transcript }] },
    },
  },
});
describe("voiceNoteTranscriptsByRun", () => {
  it("keeps the full transcript from the completed canonical tool on its run", () => {
    expect(voiceNoteTranscriptsByRun([entry("completed")]).get(runId)).toEqual([transcript]);
  });
  it("ignores unfinished calls and other tools", () => {
    expect(voiceNoteTranscriptsByRun([entry("inProgress"), entry("completed", "other")]).size).toBe(
      0,
    );
  });
  it("does not duplicate a repeated tool output", () => {
    expect(voiceNoteTranscriptsByRun([entry("completed"), entry("completed")]).get(runId)).toEqual([
      transcript,
    ]);
  });
});
