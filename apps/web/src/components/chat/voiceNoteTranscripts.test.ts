import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveWorkLogEntries,
  extractVoiceNoteTranscript,
  type TimelineEntry,
} from "../../session-logic";
import { audioAttachmentMimeType } from "../../types";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import {
  formatVoiceNoteClock,
  knownVoiceNoteDuration,
  voiceNoteSeekTime,
} from "./voiceNotePlayback";

function toolActivity(
  id: string,
  createdAt: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    createdAt,
    kind: "tool.completed",
    summary: typeof payload.title === "string" ? payload.title : "Tool",
    tone: "tool",
    payload,
    turnId: TurnId.make("turn-1"),
  };
}

// The shape Hermes sent before it named its tool calls (stored in a live T3 database).
const legacyTranscript = toolActivity("transcript", "2026-10-01T17:46:06.510Z", {
  itemType: "dynamic_tool_call",
  status: "completed",
  title: "Voice note transcript",
  data: {
    toolCallId: "tc-20aa52d0dfad",
    kind: "other",
    content: [
      {
        type: "content",
        content: { type: "text", text: '🎙️ "Okay, yeah, let\'s do the voice follow-ups, please."' },
      },
    ],
  },
});

const command = toolActivity("command", "2026-10-01T17:46:30.000Z", {
  itemType: "command_execution",
  status: "completed",
  title: "Ran command",
  detail: "date",
  data: { toolCallId: "tc-1", kind: "execute", command: "date" },
});

describe("extractVoiceNoteTranscript", () => {
  it("reads the plain transcript Hermes names explicitly", () => {
    expect(
      extractVoiceNoteTranscript(
        toolActivity("named", "2026-10-01T18:00:00.000Z", {
          itemType: "dynamic_tool_call",
          title: "Voice note transcript",
          data: {
            kind: "other",
            hermesToolName: "voice_note_transcript",
            rawOutput: "Testing the voice module.",
            content: [{ type: "content", content: { type: "text", text: '🎙️ "ignored"' } }],
          },
        }),
      ),
    ).toBe("Testing the voice module.");
  });

  it("unquotes the transcript older Hermes builds only showed as text", () => {
    expect(extractVoiceNoteTranscript(legacyTranscript)).toBe(
      "Okay, yeah, let's do the voice follow-ups, please.",
    );
    // The same row as the server projects it for clients: content folded into rawOutput.
    expect(
      extractVoiceNoteTranscript(
        toolActivity("projected", "2026-10-01T17:46:06.510Z", {
          itemType: "dynamic_tool_call",
          title: "Voice note transcript",
          data: {
            toolCallId: "tc-20aa52d0dfad",
            kind: "other",
            rawOutput: { content: '🎙️ "Okay, yeah, let\'s do the voice follow-ups, please."' },
          },
        }),
      ),
    ).toBe("Okay, yeah, let's do the voice follow-ups, please.");
  });

  it("ignores every other tool call", () => {
    expect(extractVoiceNoteTranscript(command)).toBeUndefined();
    expect(
      extractVoiceNoteTranscript(
        toolActivity("other", "2026-10-01T18:00:00.000Z", {
          itemType: "dynamic_tool_call",
          title: "session search: voice",
          data: { kind: "other", rawOutput: "results" },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("voice note transcripts in the timeline", () => {
  it("shows the transcript with the user's voice note instead of in the work log", () => {
    const workEntries = deriveWorkLogEntries([legacyTranscript, command]);
    const timelineEntries: TimelineEntry[] = [
      {
        id: "user-entry",
        kind: "message",
        createdAt: "2026-10-01T17:45:56.259Z",
        message: {
          id: "user-1" as never,
          role: "user",
          text: "[Voice note.webm](t3-context://v1/file/file_1)",
          turnId: null,
          createdAt: "2026-10-01T17:45:56.259Z",
          updatedAt: "2026-10-01T17:45:56.259Z",
          streaming: false,
        },
      },
      ...workEntries.map((entry) => ({
        id: `work:${entry.id}`,
        kind: "work" as const,
        createdAt: entry.createdAt,
        entry,
      })),
      {
        id: "assistant-entry",
        kind: "message",
        createdAt: "2026-10-01T17:47:00.000Z",
        message: {
          id: "assistant-1" as never,
          role: "assistant",
          text: "Heard you.",
          turnId: "turn-1" as never,
          createdAt: "2026-10-01T17:47:00.000Z",
          updatedAt: "2026-10-01T17:47:00.000Z",
          streaming: false,
        },
      },
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      expandedTurnIds: new Set([TurnId.make("turn-1")]),
    });

    expect(rows.find((row) => row.id === "user-entry")).toMatchObject({
      kind: "message",
      voiceNoteTranscripts: ["Okay, yeah, let's do the voice follow-ups, please."],
    });
    const workRowEntryIds = rows.flatMap((row) =>
      row.kind === "work" || row.kind === "work-live"
        ? row.groupedEntries.map((entry) => entry.id)
        : row.kind === "activity-group"
          ? row.entries.map((entry) => entry.id)
          : [],
    );
    expect(workRowEntryIds).not.toContain("transcript");
    expect(workRowEntryIds).toContain("command");
  });
});

describe("voice note playback helpers", () => {
  it("recognizes recordings by type, and by extension only when the type is generic", () => {
    const file = (name: string, mimeType: string) => ({
      type: "file" as const,
      id: "a",
      name,
      mimeType,
      sizeBytes: 1,
    });
    expect(audioAttachmentMimeType(file("Voice note.webm", "audio/webm;codecs=opus"))).toBe(
      "audio/webm",
    );
    expect(audioAttachmentMimeType(file("memo.m4a", "application/octet-stream"))).toBe("audio/mp4");
    expect(audioAttachmentMimeType(file("clip.webm", "video/webm"))).toBeNull();
    expect(audioAttachmentMimeType(file("song.mp3", "application/pdf"))).toBeNull();
  });

  it("reads clock time and seeks within the recording", () => {
    expect(formatVoiceNoteClock(null)).toBe("--:--");
    expect(formatVoiceNoteClock(7.9)).toBe("0:07");
    expect(formatVoiceNoteClock(3725)).toBe("1:02:05");
    // MediaRecorder WebM reports Infinity until the end of the file is read.
    expect(knownVoiceNoteDuration(Number.POSITIVE_INFINITY)).toBeNull();
    expect(knownVoiceNoteDuration(12.5)).toBe(12.5);
    expect(
      voiceNoteSeekTime({ pointerX: 150, trackLeft: 100, trackWidth: 200, duration: 20 }),
    ).toBe(5);
    expect(
      voiceNoteSeekTime({ pointerX: 400, trackLeft: 100, trackWidth: 200, duration: 20 }),
    ).toBe(20);
  });
});
